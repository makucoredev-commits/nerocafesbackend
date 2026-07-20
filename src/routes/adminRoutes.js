import { Router } from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Admin } from '../models/Admin.js';
import { Order } from '../models/Order.js';
import { MenuItem } from '../models/MenuItem.js';
import { Customer } from '../models/Customer.js';
import { OfferBanner } from '../models/OfferBanner.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { getOrCreateShopSettings } from '../models/ShopSettings.js';
import { authAdmin } from '../middleware/authAdmin.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import { sendSMS, makeCall } from '../utils/smsPlaceholder.js';
import { sendPaymentSuccessMessage, sendOrderReadyMessage, sendCancellationMessage } from '../utils/whatsapp.js';
import { sendInvoiceEmail, sendWelcomeEmail, sendOrderStatusEmail } from '../utils/emailPlaceholder.js';
import { createOrderFromBody } from '../utils/orderHelpers.js';
import { User } from '../models/User.js';
import { normalizePhone, validatePhone, getCountryFromCoords } from '../utils/phone.js';
import { sendUserPushNotification } from '../utils/pushNotifications.js';
import { AuditLog } from '../models/AuditLog.js';

const router = Router();
const CUSTOMER_VIBRATION_COOLDOWN_MS = 10_000;
const customerVibrationCooldown = new Map();

const ADMIN_ACCESS_EXPIRY = '30m';

function signAdminToken(admin) {
  return jwt.sign(
    { sub: admin._id.toString(), type: 'access', v: admin.tokenVersion || 0 },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: ADMIN_ACCESS_EXPIRY }
  );
}

async function issueAdminTokenPair(admin, deviceInfo = '') {
  const accessToken = signAdminToken(admin);
  const refreshToken = await RefreshToken.createForUser(admin._id, 'admin', deviceInfo);
  return { accessToken, refreshToken };
}

function computeFingerprint(ip, ua) {
  const raw = `${ip}__${ua}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/* ── Admin Login ──────────────────────────────────────────────── */
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password, fingerprint: clientFingerprint } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const admin = await Admin.findOne({ email: email.toLowerCase().trim() });
    if (!admin) return res.status(401).json({ error: 'Invalid admin credentials' });

    const ip = req.headers['x-forwarded-for'] || req.ip || '';
    const ua = req.headers['user-agent'] || '';
    const fp = clientFingerprint || computeFingerprint(ip, ua);

    /* Check if this device is trusted (auto-login) */
    const trustedIdx = (admin.trustedDevices || []).findIndex(d => d.fingerprint === fp);
    const isTrusted = trustedIdx >= 0;

    if (!isTrusted) {
      /* New device → require password */
      if (!password) return res.status(400).json({ error: 'Password required for new device' });
      if (!(await admin.comparePassword(password))) {
        return res.status(401).json({ error: 'Invalid admin credentials' });
      }
      /* Save new trusted device */
      const label = ua.includes('Mobile') ? 'Mobile Browser' :
                    ua.includes('Chrome') ? 'Chrome Desktop' :
                    ua.includes('Firefox') ? 'Firefox Desktop' : 'Unknown Browser';
      if (!admin.trustedDevices) admin.trustedDevices = [];
      admin.trustedDevices.push({ fingerprint: fp, label, lastUsed: new Date(), ip: String(ip).slice(0, 45) });
      await admin.save();
    } else {
      /* Trusted device → update lastUsed */
      admin.trustedDevices[trustedIdx].lastUsed = new Date();
      admin.trustedDevices[trustedIdx].ip = String(ip).slice(0, 45);
      await admin.save();
    }

    const deviceInfo = ua;
    const { accessToken, refreshToken } = await issueAdminTokenPair(admin, deviceInfo);
    res.json({ admin: admin.toJSON(), token: accessToken, refreshToken, trustedDevice: isTrusted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Check trusted device (auto-login probe) ──────────────────── */
router.post('/check-device', authLimiter, async (req, res) => {
  try {
    const { email, fingerprint: clientFingerprint } = req.body;
    if (!email) return res.status(400).json({ trusted: false });

    const admin = await Admin.findOne({ email: email.toLowerCase().trim() });
    if (!admin) return res.status(200).json({ trusted: false });

    const ip = req.headers['x-forwarded-for'] || req.ip || '';
    const ua = req.headers['user-agent'] || '';
    const fp = clientFingerprint || computeFingerprint(ip, ua);

    const trusted = (admin.trustedDevices || []).some(d => d.fingerprint === fp);
    res.json({ trusted });
  } catch {
    res.json({ trusted: false });
  }
});

/* ── Admin refresh token ──────────────────────────────────────── */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken: rt } = req.body;
    if (!rt) return res.status(400).json({ error: 'Refresh token required' });

    const doc = await RefreshToken.verifyToken(rt, 'admin');
    if (!doc) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    const admin = await Admin.findById(doc.userId);
    if (!admin) {
      await RefreshToken.revokeToken(rt);
      return res.status(401).json({ error: 'Admin not found' });
    }

    await RefreshToken.revokeToken(rt);
    const deviceInfo = req.headers['user-agent'] || '';
    const { accessToken, refreshToken } = await issueAdminTokenPair(admin, deviceInfo);
    res.json({ token: accessToken, refreshToken });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Logout from all devices ──────────────────────────────────── */
router.post('/logout-all', authAdmin, async (req, res) => {
  try {
    await RefreshToken.revokeAllForUser(req.admin._id, 'admin');
    const admin = await Admin.findById(req.admin._id);
    if (admin) {
      admin.trustedDevices = [];
      admin.tokenVersion = (admin.tokenVersion || 0) + 1;
      await admin.save();
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Get current admin info ───────────────────────────────────── */
router.get('/me', authAdmin, async (req, res) => {
  try {
    res.json({ admin: req.admin.toJSON() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Trusted devices management ───────────────────────────────── */
router.get('/trusted-devices', authAdmin, async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin._id);
    res.json({ devices: admin?.trustedDevices || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/trusted-devices/:fingerprint', authAdmin, async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin._id);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    admin.trustedDevices = (admin.trustedDevices || []).filter(d => d.fingerprint !== req.params.fingerprint);
    await admin.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Admin info ───────────────────────────────────────────────── */

router.get('/me', authAdmin, (req, res) => {
  res.json({ admin: req.admin });
});

router.get('/stats', authAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;

    const filterDate = {};
    if (from || to) {
      filterDate.createdAt = {};
      if (from) filterDate.createdAt.$gte = new Date(from);
      if (to) filterDate.createdAt.$lte = new Date(to);
    }

    const totalOrdersFilter = { cancelledAt: null, ...filterDate };
    const totalOrders = await Order.countDocuments(totalOrdersFilter);
    const activeOrders = await Order.countDocuments({
      cancelledAt: null,
      status: { $in: ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing', 'Ready'] },
      ...filterDate,
    });
    const completedOrders = await Order.countDocuments({
      cancelledAt: null,
      status: 'Completed',
      ...filterDate,
    });
    const revenueAgg = await Order.aggregate([
      { $match: { cancelledAt: null, ...filterDate } },
      { $group: { _id: null, total: { $sum: '$totalPrice' } } },
    ]);
    const revenue = revenueAgg[0]?.total || 0;

    const popularAgg = await Order.aggregate([
      { $match: { cancelledAt: null, ...filterDate } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.name',
          count: { $sum: '$items.quantity' },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 6 },
    ]);

    let dateRangeFilter;
    if (from || to) {
      dateRangeFilter = { cancelledAt: null, ...filterDate };
    } else {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
      sevenDaysAgo.setHours(0, 0, 0, 0);
      dateRangeFilter = { cancelledAt: null, createdAt: { $gte: sevenDaysAgo } };
    }

    const dailyAgg = await Order.aggregate([
      { $match: dateRangeFilter },
      {
        $group: {
          _id: {
            y: { $year: '$createdAt' },
            m: { $month: '$createdAt' },
            d: { $dayOfMonth: '$createdAt' },
          },
          orders: { $sum: 1 },
          revenue: { $sum: '$totalPrice' },
        },
      },
      { $sort: { '_id.y': 1, '_id.m': 1, '_id.d': 1 } },
    ]);

    const topCustomersAgg = await Order.aggregate([
      { $match: { cancelledAt: null, ...filterDate } },
      {
        $group: {
          _id: {
            name: '$customer.name',
            phone: '$customer.phone',
            email: '$customer.email',
          },
          orders: { $sum: 1 },
          spent: { $sum: '$totalPrice' },
        },
      },
      { $sort: { spent: -1 } },
      { $limit: 6 },
    ]);

    const statusAgg = await Order.aggregate([
      { $match: { cancelledAt: null, ...filterDate } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);

    res.json({
      totalOrders,
      revenue,
      activeOrders,
      completedOrders,
      statusDistribution: statusAgg.map((s) => ({ name: s._id, value: s.count })),
      popularItems: popularAgg.map((p) => ({ name: p._id, count: p.count })),
      dailyOrders: dailyAgg.map((d) => ({
        day: `${String(d._id.d).padStart(2, '0')}/${String(d._id.m).padStart(2, '0')}`,
        orders: d.orders,
        revenue: Math.round(d.revenue),
      })),
      topCustomers: topCustomersAgg.map((c) => ({
        name: c._id.name || 'Guest',
        phone: c._id.phone || '',
        email: c._id.email || '',
        orders: c.orders,
        spent: Math.round(c.spent),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/orders', authAdmin, async (_req, res) => {
  try {
    // Fetch all orders including canceled ones for history view
    const orders = await Order.find({}).sort({ createdAt: -1 }).limit(500);
    res.json({ orders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Check if a customer has pending orders (by phone)
router.get('/orders/check-pending/:phone', authAdmin, async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const pendingOrders = await Order.find({
      'customer.phone': phone,
      status: { $in: ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing', 'Ready'] },
      cancelledAt: null,
    }).sort({ createdAt: -1 });

    const hasPending = pendingOrders.length > 0;
    
    res.json({
      hasPending,
      count: pendingOrders.length,
      orders: hasPending ? pendingOrders.map(o => ({
        _id: o._id,
        orderNo: o.orderNo,
        status: o.status,
        createdAt: o.createdAt,
        totalPrice: o.totalPrice,
        items: o.items,
      })) : [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/orders
 * Create a manual order (Reception)
 */
router.post('/orders', authAdmin, async (req, res) => {
  try {
    const { items, customer, paymentMethod = 'COD', notes, location } = req.body;
    if (!items?.length || !customer?.name || !customer?.phone) {
      return res.status(400).json({ error: 'Items and customer name/phone required' });
    }

    // Validate phone number based on GPS location (if provided)
    let countryCode = 'IN'; // Default to India for admin orders
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

    // Optional: Search for existing user to link
    const normPhone = normalizePhone(customer.phone);
    let existingUser = await User.findOne({ phone: normPhone });

    // Fallback: If not found by normalized phone, try searching with different normalization patterns
    if (!existingUser) {
      console.log('[Admin Order] User lookup by normalized phone failed, trying raw phone:', {
        normPhone,
        rawPhone: customer.phone,
      });

      // Try searching all users and normalize both sides
      const allUsers = await User.find({}).lean();
      existingUser = allUsers.find(u => normalizePhone(u.phone) === normPhone);

      if (existingUser) {
        existingUser = await User.findById(existingUser._id); // Re-fetch to get full document
        console.log('[Admin Order] User found via fallback normalization:', {
          userId: existingUser._id,
          storedPhone: existingUser.phone,
          normalizedMatch: normalizePhone(existingUser.phone),
        });
      }
    }

    // Auto-create user if not exists and email is provided
    let newUserCreated = false;
    if (!existingUser && customer.email) {
      console.log('[Admin Order] Auto-creating new user account for customer:', {
        name: customer.name,
        phone: normPhone,
        email: customer.email,
      });

      const generatedPassword = crypto.randomBytes(4).toString('hex');
      existingUser = await User.create({
        name: customer.name,
        email: customer.email.toLowerCase().trim(),
        phone: normPhone,
        password: generatedPassword,
        mustChangePassword: false,
      });
      newUserCreated = true;

      try {
        await sendWelcomeEmail({
          to: customer.email,
          name: customer.name,
          email: customer.email,
          password: generatedPassword,
        });
        console.log('[Admin Order] Welcome email sent to new user:', customer.email);
      } catch (err) {
        console.warn('[Admin Order] Welcome email failed:', err.message);
      }
    }

    // Check if customer already has an active order that is still in progress
    const existingPendingOrder = await Order.findOne({
      'customer.phone': normPhone,
      status: { $in: ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing', 'Ready'] },
      cancelledAt: null,
    });

    if (existingPendingOrder) {
      return res.status(400).json({
        error: 'Customer already has a pending order',
        existingOrderId: existingPendingOrder._id,
        existingOrderNo: existingPendingOrder.orderNo,
        existingStatus: existingPendingOrder.status,
      });
    }

    const io = req.app.get('io');
    const { order, trackingToken } = await createOrderFromBody({
      items,
      customer,
      paymentMethod,
      isOutOfRange: false, // Manual orders are always in-range
      userId: existingUser?._id,
      location: null,
      io,
    });

    if (notes) {
      order.notes = notes;
      await order.save();
    }

    // Calculate ETA using ETA Engine
    const etaEngine = req.app.get('etaEngine');
    if (etaEngine) {
      // Populate preparation times from menu items
      for (const item of order.items) {
        const menuItem = await MenuItem.findById(item.menuItemId);
        if (menuItem) {
          item.preparationTime = menuItem.preparationTime || 10;
          item.bufferTime = menuItem.bufferTime || 2;
        }
      }

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
    }

    console.log('[Admin Order] Created manual order:', {
      orderId: order._id,
      orderNo: order.orderNo,
      customerName: customer.name,
      customerPhone: normPhone,
      hasUser: !!existingUser,
      userId: existingUser?._id,
      trackingToken: trackingToken.substring(0, 8) + '...',
      estimatedPrepTime: order.estimatedPrepTime,
    });

    // Emit real-time notification to customer if they have a user account
    if (existingUser) {
      console.log('[Admin Order] Emitting order:created to user room:', {
        userId: existingUser._id,
        room: `user:${existingUser._id}`,
      });
      
      io?.to(`user:${existingUser._id}`).emit('order:created', {
        orderId: order._id,
        orderNo: order.orderNo,
        totalPrice: order.totalPrice,
        status: order.status,
        createdAt: order.createdAt,
        items: order.items,
        customerName: order.customer?.name,
        trackingToken: trackingToken, // Include token so customer can track
      });

      // Send Push Notification
      sendUserPushNotification(existingUser._id, 'Order Placed!', {
        body: `Your order #${order.orderNo} has been placed successfully for ₹${order.totalPrice}.`,
        data: { url: `/track/${order._id}` },
        tag: `order-${order._id}`,
      }).catch(e => console.error('[Push] Manual order create notify error:', e.message));

      // Send WhatsApp notification to customer about their order
      try {
        sendPaymentSuccessMessage(normPhone, customer.name, order.orderNo, order._id, trackingToken);
        console.log('[Admin Order] WhatsApp notification sent to:', normPhone);
      } catch (e) {
        console.warn('[Admin Order] Failed to send WhatsApp notification:', e.message);
      }

      // Send SMS notification
      try {
        await sendSMS('OrderPlaced', normPhone, { 
          orderId: order._id, 
          orderNo: order.orderNo,
          customerName: customer.name 
        });
        console.log('[Admin Order] SMS notification sent to:', normPhone);
      } catch (e) {
        console.warn('[Admin Order] Failed to send SMS notification:', e.message);
      }

      // Send Email notification if email exists
      try {
        if (existingUser.email || customer.email) {
          await sendInvoiceEmail({
            to: existingUser.email || customer.email,
            name: customer.name,
            orderId: order._id,
            total: order.totalPrice,
          });
          console.log('[Admin Order] Email notification sent to:', existingUser.email || customer.email);
        }
      } catch (e) {
        console.warn('[Admin Order] Failed to send email notification:', e.message);
      }
    } else {
      console.log('[Admin Order] No registered user found for phone:', normPhone);
      // Still send SMS for non-registered users
      try {
        await sendSMS('OrderPlaced', normPhone, { 
          orderId: order._id, 
          orderNo: order.orderNo,
          customerName: customer.name 
        });
        console.log('[Admin Order] SMS notification sent to unregistered user:', normPhone);
      } catch (e) {
        console.warn('[Admin Order] Failed to send SMS notification to unregistered user:', e.message);
      }
    }

    // Emit to admin dashboard for real-time updates (same event as customer orders)
    io?.emit('orders:update', {
      type: 'created',
      status: 'Received',
      orderId: order._id,
      orderNo: order.orderNo,
      customerName: customer.name,
      totalPrice: order.totalPrice,
      itemCount: order.items.length,
      createdAt: order.createdAt,
    });

    res.status(201).json({
      order,
      trackingToken,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add items to a pending order (admin)
router.patch('/orders/:id/items', authAdmin, async (req, res) => {
  try {
    const { items } = req.body; // [{ menuItemId, quantity }]
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Items required' });
    const order = await Order.findOne({ _id: req.params.id, cancelledAt: null });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!['Received', 'Confirmed', 'Queued'].includes(order.status)) return res.status(400).json({ error: 'Only received/confirmed/queued orders can be modified' });

    let total = order.totalPrice || 0;
    for (const it of items) {
      if (!it.menuItemId) continue;
      const m = await MenuItem.findById(it.menuItemId);
      if (!m || !m.available) continue;
      const qty = Math.max(1, Number(it.quantity) || 1);
      total += m.price * qty;
      order.items.push({
        menuItemId: m._id,
        name: m.name,
        image: m.image || '',
        price: m.price,
        quantity: qty,
      });
      await MenuItem.updateOne({ _id: m._id }, { $inc: { orderCount: qty } });
    }
    order.totalPrice = Math.round(total);
    await order.save();
    const io = req.app.get('io');
    io?.emit('orders:update', { type: 'modified', orderId: order._id });
    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update payment info/status for an order (admin)
router.patch('/orders/:id/payment', authAdmin, async (req, res) => {
  try {
    const { paymentStatus, paymentMeta } = req.body; // paymentStatus: 'Completed'|'Failed'|'Refunded'
    const allowed = ['Pending', 'Completed', 'Failed', 'Refunded', 'Cash Pending'];
    if (paymentStatus && !allowed.includes(paymentStatus)) return res.status(400).json({ error: 'Invalid payment status' });
    const order = await Order.findOne({ _id: req.params.id });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (paymentMeta && typeof paymentMeta === 'object') {
      order.paymentMeta = { ...(order.paymentMeta || {}), ...paymentMeta };
    }
    if (paymentStatus) order.paymentStatus = paymentStatus;

    // If admin marks refunded, also set cancelledAt if not already
    if (paymentStatus === 'Refunded' && !order.cancelledAt) {
      order.cancelledAt = new Date();
    }

    await order.save();
    const io = req.app.get('io');
    io?.emit('orders:update', { type: 'payment', orderId: order._id });
    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/orders/:id/trigger-vibration', authAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.userId) return res.status(400).json({ error: 'This order is not linked to a customer account' });

    const orderKey = order._id.toString();
    const now = Date.now();
    const lastTriggeredAt = customerVibrationCooldown.get(orderKey) || 0;
    if (now - lastTriggeredAt < CUSTOMER_VIBRATION_COOLDOWN_MS) {
      return res.status(429).json({ error: 'Customer alert can only be triggered once every 10 seconds.' });
    }
    customerVibrationCooldown.set(orderKey, now);

    const io = req.app.get('io');
    const customerRoom = `customer:${order.userId.toString()}`;
    io?.to(customerRoom).emit('customer:device_alert', {
      orderId: order._id.toString(),
      customerId: order.userId.toString(),
      pattern: [300, 150, 300],
      source: 'admin',
      triggeredAt: new Date().toISOString(),
      adminId: req.admin._id.toString(),
      adminName: req.admin.name || 'Store Admin',
    });

    await AuditLog.create({
      action: 'CUSTOMER_VIBRATION',
      userId: req.admin._id,
      userType: 'admin',
      ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      method: req.method,
      path: req.path,
      body: {
        orderId: order._id,
        customerId: order.userId,
        adminId: req.admin._id,
        alertSent: true,
      },
      query: req.query,
      status: 200,
      success: true,
      timestamp: new Date(),
    });

    res.json({
      ok: true,
      orderId: order._id,
      customerId: order.userId,
      pattern: [300, 150, 300],
      cooldownMs: CUSTOMER_VIBRATION_COOLDOWN_MS,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/orders/:id/status', authAdmin, async (req, res) => {
  try {
    const { status, chefId } = req.body;
    const allowed = ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing', 'Ready', 'Completed', 'Cancelled'];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${allowed.join(', ')}` });
    }
    
    const order = await Order.findOne({ _id: req.params.id, cancelledAt: null });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const prev = order.status;
    order.status = status;

    // Handle chef assignment
    if (chefId && ['Preparing', 'Cooking', 'Packing'].includes(status)) {
      order.chefAssigned = chefId;
    }

    // Update timestamps based on status
    const now = new Date();
    switch (status) {
      case 'Preparing':
        if (!order.preparationStartedAt) order.preparationStartedAt = now;
        break;
      case 'Cooking':
        if (!order.cookingStartedAt) order.cookingStartedAt = now;
        break;
      case 'Packing':
        if (!order.packingStartedAt) order.packingStartedAt = now;
        break;
      case 'Ready':
        if (!order.readyAt) order.readyAt = now;
        order.remainingTime = 0;
        break;
      case 'Completed':
      case 'Cancelled':
        order.remainingTime = 0;
        break;
    }

    await order.save();

    // Trigger ETA engine status change handler
    const etaEngine = req.app.get('etaEngine');
    if (etaEngine) {
      await etaEngine.handleOrderStatusChange(order._id.toString(), status, prev);
    }

    const phone = order.customer?.phone;
    if (phone && status === 'Preparing' && prev !== 'Preparing') {
      await sendSMS('Preparing', phone, { orderId: order._id });
    }
    if (phone && status === 'Ready' && prev !== 'Ready') {
      await sendSMS('Ready', phone, { orderId: order._id });
      await makeCall(phone);
      try {
        const result = await sendOrderReadyMessage(phone, order.customer?.name || 'Customer', order.orderNo);
        if (!result.ok) {
          console.warn('WhatsApp send failed:', result.error);
        }
      } catch (e) {
        console.warn('WhatsApp send failed', e.message || e);
      }
      try {
        if (order.customer?.email) {
          await sendInvoiceEmail({
            to: order.customer.email,
            name: order.customer.name,
            orderId: order._id,
            orderNo: order.orderNo,
            total: order.totalPrice,
            items: order.items,
          });
        }
      } catch (e) {
        console.warn('Invoice send failed', e.message || e);
      }
    }

    const io = req.app.get('io');
    const oid = order._id.toString();
    io?.to(`order:${oid}`).emit('order:status', { orderId: oid, status: order.status });
    io?.emit('orders:update', { type: 'status', orderId: oid });

    if (order.userId) {
      let pushTitle = 'Order Update';
      let pushBody = `Your order #${order.orderNo} is now ${status}.`;

      if (status === 'Confirmed') {
        pushTitle = '✅ Order Confirmed';
        pushBody = `Your order #${order.orderNo} has been confirmed! We'll start preparing it soon.`;
      } else if (status === 'Preparing') {
        pushTitle = '🔥 Preparing Your Order';
        pushBody = `Hang tight! We've started preparing your order #${order.orderNo}.`;
      } else if (status === 'Cooking') {
        pushTitle = '🍳 Cooking Your Order';
        pushBody = `Your order #${order.orderNo} is now being cooked!`;
      } else if (status === 'Packing') {
        pushTitle = '📦 Packing Your Order';
        pushBody = `Your order #${order.orderNo} is being packed.`;
      } else if (status === 'Ready') {
        pushTitle = '☕ Order Ready!';
        pushBody = `Your order #${order.orderNo} is ready for pickup! See you soon.`;
      } else if (status === 'Completed') {
        pushTitle = '✨ Enjoy your meal!';
        pushBody = `Order #${order.orderNo} has been completed. Hope you like it!`;
      }

      sendUserPushNotification(order.userId, pushTitle, {
        body: pushBody,
        data: { url: `/track/${order._id}` },
        tag: `order-${order._id}`,
      }).catch(e => console.error('[Push] Status update notify error:', e.message));
    }

    // Send order status email notification for meaningful transitions
    // Skip 'Ready' status as we send invoice email instead
    if (order.customer?.email && status !== prev && status !== 'Ready') {
      sendOrderStatusEmail({
        to: order.customer.email,
        name: order.customer.name || 'Customer',
        orderNo: order.orderNo,
        status,
        orderId: order._id,
        reason: req.body.reason || '',
      }).catch(e => console.warn('[Email] Status email failed:', e.message));
    }

    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/orders/:id/cancel', authAdmin, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, cancelledAt: null });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    
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
    order.remainingTime = 0;
    await order.save();
    
    // Remove from ETA engine queue
    if (etaEngine) {
      etaEngine.kitchenQueue.delete(order._id.toString());
      if (order.chefAssigned) {
        etaEngine.removeChefFromOrder(order.chefAssigned.toString(), order._id.toString());
      }
      // Recalculate affected orders
      await etaEngine.recalculateAffectedOrders(order._id.toString());
    }
    
    const phone = order.customer?.phone;
    if (phone) {
      try {
        await sendCancellationMessage(phone, order.customer?.name || 'Customer', order.orderNo);
      } catch (e) {
        console.warn('Failed to send cancellation WhatsApp message:', e.message || e);
      }
    }
    
    const io = req.app.get('io');
    const oid = order._id.toString();
    io?.to(`order:${oid}`).emit('order:status', { orderId: oid, status: 'Cancelled' });
    io?.emit('orders:update', { type: 'cancelled', orderId: order._id });

    if (order.userId) {
      sendUserPushNotification(order.userId, 'Order Cancelled', {
        body: `Your order #${order.orderNo} has been cancelled.`,
        data: { url: `/track/${order._id}` },
        tag: `order-${order._id}`,
      }).catch(e => console.error('[Push] Cancel notify error:', e.message));
    }

    res.json({ ok: true, order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual invoice email trigger
router.post('/orders/:id/email-invoice', authAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.customer?.email) {
      return res.status(400).json({ error: 'Customer has no email address registered.' });
    }

    await sendInvoiceEmail({
      to: order.customer.email,
      name: order.customer.name,
      orderId: order._id,
      total: order.totalPrice,
    });

    res.json({ ok: true, message: 'Invoice email sent successfully!' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a single order
router.delete('/orders/:id', authAdmin, async (req, res) => {
  try {
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const io = req.app.get('io');
    io?.emit('orders:update', { type: 'deleted', orderId: order._id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bulk delete orders
router.post('/orders/bulk/delete', authAdmin, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || !orderIds.length) {
      return res.status(400).json({ error: 'Order IDs array required' });
    }
    const result = await Order.deleteMany({ _id: { $in: orderIds } });
    const io = req.app.get('io');
    io?.emit('orders:update', { type: 'bulk_deleted', count: result.deletedCount });
    res.json({ ok: true, deletedCount: result.deletedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/customers', authAdmin, async (req, res) => {
  try {
    const q = req.query.q?.trim();
    if (q) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const customers = await Customer.find({
        $or: [
          { name: new RegExp(escaped, 'i') },
          { phone: new RegExp(escaped.replace(/\D/g, ''), 'i') },
          { email: new RegExp(escaped, 'i') },
        ],
      })
        .limit(20)
        .sort({ updatedAt: -1 });
      return res.json({ customers });
    }
    const customers = await Customer.find().sort({ updatedAt: -1 }).limit(100);
    res.json({ customers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/customers', authAdmin, async (req, res) => {
  try {
    const { name, phone, email, countryCode = '91', notes = '', birthday = null, favouriteItems = [] } = req.body;
    const normalizedEmail = String(email ?? '').trim().toLowerCase();

    if (!name || !phone || !normalizedEmail) {
      return res.status(400).json({ error: 'Name, phone and email are required' });
    }

    const normPhone = normalizePhone(phone, countryCode);
    
    // Check if customer already exists by normalized phone
    const existingCustomer = await Customer.findOne({ phone: normPhone });
    if (existingCustomer) {
      return res.status(400).json({ error: 'Customer account already exists.' });
    }

    // Check if user account exists
    let existingUser = null;
    if (normalizedEmail) {
      existingUser = await User.findOne({ 
        $or: [
          { phone: normPhone },
          { email: normalizedEmail }
        ]
      });
    } else {
      existingUser = await User.findOne({ phone: normPhone });
    }

    let generatedPassword = '';
    let userId = null;
    let welcomeEmailSent = false;

    if (!existingUser && normalizedEmail) {
      generatedPassword = crypto.randomBytes(4).toString('hex');
      const newUser = await User.create({
        name,
        email: normalizedEmail,
        phone: normPhone,
        password: generatedPassword,
        mustChangePassword: false,
      });
      existingUser = newUser;
      userId = newUser._id;

      try {
        const emailResult = await sendWelcomeEmail({
          to: normalizedEmail,
          name,
          email: normalizedEmail,
          password: generatedPassword,
        });
        welcomeEmailSent = !!emailResult?.ok;
      } catch (err) {
        console.warn('[Admin Create Customer] Welcome email failed:', err.message);
      }
    } else if (existingUser) {
      userId = existingUser._id;
    }

    const customer = await Customer.create({
      name,
      phone: normPhone,
      email: normalizedEmail,
      userId,
      countryCode,
      notes,
      birthday: birthday ? new Date(birthday) : null,
      favouriteItems,
      orderCount: 0
    });

    res.status(201).json({
      customer,
      generatedCredentials: !!generatedPassword,
      welcomeEmailSent,
    });
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.error('[Admin Create Customer] Unexpected error:', e);
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.patch('/customers/:id', authAdmin, async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      countryCode,
      address,
      notes,
      birthday,
      favouriteItems,
      status,
      rewardPoints,
      tags,
      profileImage,
    } = req.body;
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : undefined;
    const customer = await Customer.findById(req.params.id);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    if (name !== undefined) customer.name = name;
    if (normalizedEmail !== undefined) customer.email = normalizedEmail;
    if (phone !== undefined) {
      customer.phone = normalizePhone(phone, countryCode || customer.countryCode);
    }
    if (countryCode !== undefined) customer.countryCode = countryCode;
    if (address !== undefined) customer.address = address;
    if (notes !== undefined) customer.notes = notes;
    if (birthday !== undefined) customer.birthday = birthday ? new Date(birthday) : null;
    if (favouriteItems !== undefined) customer.favouriteItems = favouriteItems;
    if (status !== undefined) customer.status = status;
    if (rewardPoints !== undefined) customer.rewardPoints = Number(rewardPoints || 0);
    if (tags !== undefined) customer.tags = Array.isArray(tags) ? tags : String(tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
    if (profileImage !== undefined) customer.profileImage = profileImage || '';

    await customer.save();

    if (customer.userId) {
      const userUpdates = {};
      if (name !== undefined) userUpdates.name = name;
      if (normalizedEmail !== undefined) userUpdates.email = normalizedEmail;
      if (phone !== undefined) {
        userUpdates.phone = normalizePhone(phone, countryCode || customer.countryCode);
      }
      if (Object.keys(userUpdates).length > 0) {
        await User.findByIdAndUpdate(customer.userId, userUpdates);
      }
    }

    res.json({ customer });
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.error('[Admin Update Customer] Unexpected error:', e);
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.delete('/customers/:id', authAdmin, async (req, res) => {
  try {
    const c = await Customer.findByIdAndDelete(req.params.id);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/banners', authAdmin, async (_req, res) => {
  try {
    const banners = await OfferBanner.find().sort({ createdAt: -1 });
    res.json({ banners });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/banners', authAdmin, async (req, res) => {
  try {
    const { title, message, active = true } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
    const banner = await OfferBanner.create({ title: String(title).slice(0, 200), message: String(message).slice(0, 500), active });
    const io = req.app.get('io');
    io?.emit('banner:update');
    res.status(201).json({ banner });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/banners/:id', authAdmin, async (req, res) => {
  try {
    const { title, message, active } = req.body;
    const updates = {};
    if (title !== undefined) updates.title = String(title).slice(0, 200);
    if (message !== undefined) updates.message = String(message).slice(0, 500);
    if (active !== undefined) updates.active = !!active;
    const banner = await OfferBanner.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!banner) return res.status(404).json({ error: 'Not found' });
    const io = req.app.get('io');
    io?.emit('banner:update');
    res.json({ banner });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/banners/:id', authAdmin, async (req, res) => {
  try {
    await OfferBanner.findByIdAndDelete(req.params.id);
    const io = req.app.get('io');
    io?.emit('banner:update');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/shop', authAdmin, async (_req, res) => {
  try {
    const s = await getOrCreateShopSettings();
    let heroMenuItem = null;
    if (s.heroMenuItemId) {
      const m = await MenuItem.findById(s.heroMenuItemId).lean();
      if (m) {
        heroMenuItem = {
          _id: m._id,
          name: m.name,
          price: m.price,
          category: m.category,
          image: m.image || '',
        };
      }
    }
    res.json({
      shopOpen: s.shopOpen,
      closedMessage: s.closedMessage,
      heroCardLabel: s.heroCardLabel || "Tonight's pick",
      heroMenuItemId: s.heroMenuItemId ? s.heroMenuItemId.toString() : null,
      heroMenuItem,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/shop', authAdmin, async (req, res) => {
  try {
    const { shopOpen, closedMessage, heroCardLabel, heroMenuItemId } = req.body;
    const s = await getOrCreateShopSettings();
    if (typeof shopOpen === 'boolean') s.shopOpen = shopOpen;
    if (typeof closedMessage === 'string' && closedMessage.trim()) {
      s.closedMessage = closedMessage.trim().slice(0, 300);
    }
    if (heroCardLabel !== undefined) {
      const t = String(heroCardLabel).trim().slice(0, 100);
      s.heroCardLabel = t || "Tonight's pick";
    }
    if (heroMenuItemId !== undefined) {
      if (heroMenuItemId === null || heroMenuItemId === '') {
        s.heroMenuItemId = null;
      } else if (mongoose.isValidObjectId(heroMenuItemId)) {
        const exists = await MenuItem.findById(heroMenuItemId);
        if (!exists) return res.status(400).json({ error: 'Menu item not found' });
        s.heroMenuItemId = heroMenuItemId;
      } else {
        return res.status(400).json({ error: 'Invalid menu item id' });
      }
    }
    await s.save();
    const io = req.app.get('io');
    io?.emit('shop:update');
    let heroMenuItem = null;
    if (s.heroMenuItemId) {
      const m = await MenuItem.findById(s.heroMenuItemId).lean();
      if (m) {
        heroMenuItem = {
          _id: m._id,
          name: m.name,
          price: m.price,
          category: m.category,
          image: m.image || '',
        };
      }
    }
    res.json({
      shopOpen: s.shopOpen,
      closedMessage: s.closedMessage,
      heroCardLabel: s.heroCardLabel || "Tonight's pick",
      heroMenuItemId: s.heroMenuItemId ? s.heroMenuItemId.toString() : null,
      heroMenuItem,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ── Kitchen Queue & ETA Management ──────────────────────────────── */

/**
 * GET /admin/kitchen/queue
 * Get current kitchen queue with ETA information
 */
router.get('/kitchen/queue', authAdmin, async (req, res) => {
  try {
    const queue = await getKitchenQueue();
    res.json({ queue });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/kitchen/assign-chef
 * Assign chef to order and start preparation
 */
router.post('/kitchen/assign-chef', authAdmin, async (req, res) => {
  try {
    const { orderId, chefId } = req.body;
    if (!orderId || !chefId) {
      return res.status(400).json({ error: 'Order ID and Chef ID required' });
    }
    const order = await assignChefToOrder(orderId, chefId);
    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/kitchen/complete-preparation
 * Mark order preparation as complete
 */
router.post('/kitchen/complete-preparation', authAdmin, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: 'Order ID required' });
    }
    const order = await completeOrderPreparation(orderId);
    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/orders/calculate-eta
 * Calculate ETA for a potential order (before submission)
 */
router.post('/orders/calculate-eta', authAdmin, async (req, res) => {
  try {
    const { items } = req.body;
    if (!items?.length) {
      return res.status(400).json({ error: 'Items required' });
    }
    const etaCalculation = await calculateOrderETA(items);
    res.json(etaCalculation);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
