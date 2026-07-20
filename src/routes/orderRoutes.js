import { Router } from 'express';
import { Order } from '../models/Order.js';
import { authUser, requireUser } from '../middleware/authUser.js';
import { getOrCreateShopSettings } from '../models/ShopSettings.js';
import { createOrderFromBody } from '../utils/orderHelpers.js';
import { normalizePhone, validatePhone, getCountryFromCoords } from '../utils/phone.js';
import { sendUserPushNotification } from '../utils/pushNotifications.js';
import { MenuItem } from '../models/MenuItem.js';
import { getMenuItemMaxQuantity } from '../utils/inventoryBroadcast.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.post('/validate-cart', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    let valid = true;
    const adjustments = [];

    for (const item of items) {
      const menuItemId = item.menuItemId || item.id || item._id;
      if (!menuItemId) continue;

      const menuItem = await MenuItem.findById(menuItemId).populate('ingredients.inventoryItemId');
      if (!menuItem || menuItem.available === false) {
        adjustments.push({
          menuItemId,
          name: menuItem ? menuItem.name : 'Unknown Item',
          requestedQty: item.quantity,
          availableQty: 0,
          removed: true,
          reason: 'Item is no longer available'
        });
        valid = false;
        continue;
      }

      if (menuItem.autoInventory) {
        const maxQty = await getMenuItemMaxQuantity(menuItem);
        if (maxQty <= 0) {
          adjustments.push({
            menuItemId,
            name: menuItem.name,
            requestedQty: item.quantity,
            availableQty: 0,
            removed: true,
            reason: 'Item is out of stock'
          });
          valid = false;
        } else if (item.quantity > maxQty) {
          adjustments.push({
            menuItemId,
            name: menuItem.name,
            requestedQty: item.quantity,
            availableQty: maxQty,
            adjusted: true,
            reason: `Only ${maxQty} available`
          });
          valid = false;
        }
      }
    }

    res.json({
      valid,
      adjustments,
      message: valid ? 'All items in stock' : 'Stock changed while you were shopping.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Logged-in users only */
router.post('/', authUser, requireUser, async (req, res) => {
  try {
    const settings = await getOrCreateShopSettings();
    if (!settings.shopOpen) {
      return res.status(403).json({
        error: settings.closedMessage || 'The cafe is closed. Try again tomorrow.',
        shopClosed: true,
      });
    }
    const { items, customer, paymentMethod = 'Razorpay', isOutOfRange = false, location } = req.body;
    if (!items?.length || !customer?.name || !customer?.phone) {
      return res.status(400).json({ error: 'Items and customer name/phone required' });
    }

    // Validate phone number based on GPS location
    let countryCode = 'IN'; // Default to India
    if (location && location.lat != null && location.lng != null) {
      countryCode = getCountryFromCoords(Number(location.lat), Number(location.lng));
    }

    const phoneValidation = validatePhone(customer.phone, countryCode);
    if (!phoneValidation.valid) {
      return res.status(400).json({ 
        error: phoneValidation.error,
        countryCode 
      });
    }
    
    logger.info('ORDERS', 'User placing order', {
      userId: req.user._id,
      customerName: customer.name,
      itemCount: items.length,
    });

    // Check if user already has an active order that is still in progress
    const normPhone = normalizePhone(customer.phone);
    const existingPendingOrder = await Order.findOne({
      'customer.phone': normPhone,
      status: { $in: ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing', 'Ready'] },
      cancelledAt: null,
    });

    if (existingPendingOrder) {
      return res.status(400).json({
        error: 'You already have a pending order',
        existingOrderId: existingPendingOrder._id,
        existingOrderNo: existingPendingOrder.orderNo,
        existingStatus: existingPendingOrder.status,
      });
    }

    const io = req.app.get('io');
    const etaEngine = req.app.get('etaEngine');
    
    const { order, trackingToken } = await createOrderFromBody({
      items,
      customer,
      paymentMethod,
      isOutOfRange,
      userId: req.user?._id,
      location,
      io,
    });

    // Populate preparation times from menu items
    for (const item of order.items) {
      const menuItem = await MenuItem.findById(item.menuItemId);
      if (menuItem) {
        item.category = menuItem.category || item.category || '';
        item.dietaryCategory = ['Veg', 'Non-Veg', 'Egg', 'Unknown'].includes(menuItem.dietaryCategory)
          ? menuItem.dietaryCategory
          : 'Unknown';
        item.preparationTime = menuItem.category === 'Fries' ? 7 : (menuItem.preparationTime || 10);
        item.bufferTime = menuItem.bufferTime || 2;
      }
    }

    // Calculate ETA using ETA Engine
    const etaData = await etaEngine.calculateOrderETA(order);
    order.estimatedPrepTime = etaData.estimatedPrepTime;
    order.estimatedReadyTime = etaData.estimatedReadyTime;
    order.remainingTime = etaData.remainingTime;
    order.queuePosition = await etaEngine.getQueuePosition(order);
    await order.save();

    // Add to kitchen queue
    etaEngine.kitchenQueue.set(order._id.toString(), {
      order,
      queuePosition: order.queuePosition,
      remainingTime: order.remainingTime
    });
    
    logger.success('ORDERS', `Order created successfully: NC-${order.orderNo}`, {
      orderId: order._id,
      orderNo: order.orderNo,
      userId: req.user._id,
    });
    
    const o = order.toObject();

    // Send Push Notification
    sendUserPushNotification(req.user._id, 'Order Placed! 🍕', {
      body: `Your order #${order.orderNo} has been received. We'll start preparing it soon!`,
      data: { url: `/track/${order._id}` },
      tag: `order-${order._id}`,
    }).catch(e => logger.error('NOTIFICATION', `Order create push notify error: ${e.message}`, { error: e }));

    res.status(201).json({ order: o, trackingToken });
  } catch (e) {
    const msg = e.message === 'No valid items' ? e.message : e.message;
    const code = e.message === 'No valid items' ? 400 : 500;
    res.status(code).json({ error: msg });
  }
});

router.post('/preview-eta', authUser, requireUser, async (req, res) => {
  try {
    const { items } = req.body;
    if (!items?.length) {
      return res.status(400).json({ error: 'Items required' });
    }

    const etaEngine = req.app.get('etaEngine');
    const previewOrder = {
      _id: `preview-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      items,
      priority: 'normal',
    };

    const etaData = await etaEngine.calculateOrderETA(previewOrder);
    const loadProfile = etaEngine.getLoadProfile(etaData.currentQueue || 0);

    res.json({
      ...etaData,
      thresholdMinutes: etaEngine.etaThreshold,
      exceedsThreshold: etaData.totalETA > etaEngine.etaThreshold,
      kitchenLoad: loadProfile.label,
      kitchenLoadPercent: loadProfile.percent,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/track/:id', async (req, res) => {
  try {
    const token = req.query.token || req.headers['x-tracking-token'];
    if (!token) return res.status(400).json({ error: 'Tracking token required' });
    const order = await Order.findOne({
      _id: req.params.id,
      trackingToken: token,
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/track/:id/cancel', async (req, res) => {
  try {
    const token = req.body.token || req.query.token;
    const reason = req.body.reason || '';
    if (!token) return res.status(400).json({ error: 'Tracking token required' });
    const order = await Order.findOne({ _id: req.params.id, trackingToken: token });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.cancelledAt) return res.status(400).json({ error: 'Already cancelled' });
    
    const etaEngine = req.app.get('etaEngine');
    
    // Allow cancellation if order hasn't started cooking yet
    if (['Cooking', 'Packing', 'Ready', 'Completed'].includes(order.status)) {
      return res.status(400).json({ 
        error: 'Order cannot be cancelled once preparation has started',
        canCancel: false,
        status: order.status
      });
    }
    
    order.status = 'Cancelled';
    order.cancelledAt = new Date();
    order.cancellationReason = String(reason).slice(0, 300);
    order.remainingTime = 0;
    await order.save();
    
    // Remove from ETA engine queue
    etaEngine.kitchenQueue.delete(order._id.toString());
    if (order.chefAssigned) {
      etaEngine.removeChefFromOrder(order.chefAssigned.toString(), order._id.toString());
    }
    
    // Recalculate affected orders
    await etaEngine.recalculateAffectedOrders(order._id.toString());
    
    const io = req.app.get('io');
    const oid = order._id.toString();
    io?.to(`order:${oid}`).emit('order:status', { orderId: oid, status: 'Cancelled' });
    io?.emit('orders:update', { type: 'cancelled', orderId: order._id });
    res.json({ ok: true, order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', authUser, requireUser, async (req, res) => {
  try {
    // Get all orders for the user, sorted by newest first
    const orders = await Order.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json({ orders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get tracking info for a user's specific order (by ID, user must own the order)
router.get('/track/:id/user', authUser, requireUser, async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      userId: req.user._id, // Only allow user to see their own order
    });
    if (!order) return res.status(404).json({ error: 'Order not found or does not belong to you' });
    
    res.json({ 
      order,
      trackingToken: order.trackingToken // Return token for customer use
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fallback: Get orders by phone number (useful if userId isn't set correctly)
router.get('/by-phone/:phone', async (req, res) => {
  try {
    const normPhone = normalizePhone(req.params.phone);
    logger.info('ORDERS', 'Fetching orders by phone', { normPhone });
    
    if (!normPhone) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    
    // Find all orders with this phone number
    const orders = await Order.find({
      'customer.phone': normPhone,
      cancelledAt: null,
    }).sort({ createdAt: -1 });
    
    logger.info('ORDERS', `Phone lookup found ${orders.length} order(s)`, { phone: normPhone });
    
    if (!orders.length) {
      return res.status(404).json({ 
        error: 'No active orders found for this phone number',
        phone: normPhone,
      });
    }
    
    // Return the most recent active order
    const active = orders.filter(o => o.status !== 'Completed');
    const pending = active.length > 0 ? active[0] : orders[0];
    
    logger.info('ORDERS', `Returning order NC-${pending.orderNo}`, {
      orderId: pending._id,
      status: pending.status,
    });
    
    res.json({ 
      order: pending,
      trackingToken: pending.trackingToken,
      total: orders.length,
      message: `Found ${orders.length} order(s) for this phone number`
    });
  } catch (e) {
    logger.error('ORDERS', `Phone lookup error: ${e.message}`, { error: e });
    res.status(500).json({ error: e.message });
  }
});

export default router;
