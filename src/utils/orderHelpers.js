import { v4 as uuidv4 } from 'uuid';
import { Order } from '../models/Order.js';
import { MenuItem } from '../models/MenuItem.js';
import { Customer } from '../models/Customer.js';
import { Counter } from '../models/Counter.js';
import { User } from '../models/User.js';
import { sendOrderConfirmationEmail } from './emailPlaceholder.js';
import { sendPaymentSuccessMessage } from './whatsapp.js';
import { normalizePhone } from './phone.js';
import { sendAdminPushNotification } from './pushNotifications.js';
import { StockMovement } from '../models/Inventory.js';
import { broadcastInventoryStockChange } from './inventoryBroadcast.js';
import { logger } from './logger.js';

export async function upsertCustomer({ name, phone, email, userId, totalSpent = 0 }) {
  logger.debug('ORDERS', 'Customer Loading/Upserting...', { phone });
  const normPhone = normalizePhone(phone);
  let c = await Customer.findOne({ phone: normPhone });
  if (c) {
    c.name = name;
    if (email) c.email = email;
    if (userId) c.userId = userId;
    c.orderCount = (c.orderCount || 0) + 1;
    c.totalSpending = (c.totalSpending || 0) + Number(totalSpent || 0);
    c.status = c.status || 'active';
    await c.save();
    logger.info('ORDERS', `Customer Loaded: ${c.name}`, { customerId: c._id });
    return c;
  }
  c = await Customer.create({
    name,
    phone: normPhone,
    email: email || '',
    userId: userId || null,
    orderCount: 1,
    totalSpending: Number(totalSpent || 0),
    status: 'active',
  });
  logger.success('ORDERS', `Customer Created (New Guest Profile): ${c.name}`, { customerId: c._id });
  return c;
}

export async function createOrderFromBody({ items, customer, paymentMethod, isOutOfRange, userId, location, io }) {
  logger.info('ORDERS', 'Order Request Received', { userId, paymentMethod });
  logger.debug('ORDERS', 'Order Validation Started');

  let total = 0;
  const lineItems = [];
  const normalizedItems = Array.isArray(items)
    ? items
        .map((line) => ({
          menuItemId: line?.menuItemId || line?.id,
          quantity: Math.max(1, Number(line?.quantity) || 1),
        }))
        .filter((line) => line.menuItemId)
    : [];

  if (!normalizedItems.length) {
    logger.warn('ORDERS', 'Order Validation Failed: Empty items list');
    throw new Error('No valid items');
  }

  // Stock check & items validation
  logger.debug('ORDERS', 'Stock Validation Started');
  for (const line of normalizedItems) {
    const menu = await MenuItem.findById(line.menuItemId).populate('ingredients.inventoryItemId');
    if (!menu || !menu.available) {
      logger.warn('ORDERS', `Item not available or missing: ${line.menuItemId}`);
      continue;
    }

    if (menu.autoInventory === true) {
      const ingredientStockValid = (menu.ingredients || []).every((ingredient) => {
        if (!ingredient.inventoryItemId) return true;
        const inventoryItem = ingredient.inventoryItemId;
        if (!inventoryItem || inventoryItem.isActive === false) return false;
        const requiredQuantity = Number(ingredient.quantity || 0) * Number(line.quantity || 1);
        return Number(inventoryItem.currentStock || 0) >= requiredQuantity;
      });

      if (!ingredientStockValid) {
        logger.warn('ORDERS', `Stock Validation Failed: Insufficient stock for ${menu.name}`);
        throw new Error(`Insufficient stock for ${menu.name}`);
      }
    }

    total += menu.price * line.quantity;
    lineItems.push({
      menuItemId: menu._id,
      name: menu.name,
      image: menu.image || '',
      price: menu.price,
      category: menu.category || '',
      dietaryCategory: ['Veg', 'Non-Veg', 'Egg', 'Unknown'].includes(menu.dietaryCategory) ? menu.dietaryCategory : 'Unknown',
      quantity: line.quantity,
      preparationTime: menu.category === 'Fries' ? 7 : (menu.preparationTime || 10),
      bufferTime: menu.bufferTime || 2,
    });
  }

  if (!lineItems.length) {
    logger.warn('ORDERS', 'Order Validation Failed: No valid available items');
    throw new Error('No valid items');
  }
  logger.debug('ORDERS', 'Stock Validation Passed');

  const trackingToken = uuidv4();
  
  // Track Order Number generation
  logger.debug('ORDERS', 'Order Number Generated');
  const orderNo = await Counter.getNextValue('orderNumber');
  logger.info('ORDERS', `Creating Order NC-${orderNo}`, { orderNo });

  /* Determine payment status based on method */
  const isCOD = paymentMethod === 'COD';
  const paymentStatus = isCOD ? 'Cash Pending' : 'Pending';

  /* Build location data if provided */
  const loc = {};
  if (location && location.lat != null && location.lng != null) {
    loc.lat = Number(location.lat);
    loc.lng = Number(location.lng);
    loc.mapLink = `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
  }

  const order = await Order.create({
    orderNo,
    userId: userId || null,
    trackingToken,
    items: lineItems,
    totalPrice: total,
    status: 'Received',
    customer: {
      name: String(customer.name).trim().slice(0, 100),
      phone: normalizePhone(customer.phone),
      email: customer.email ? String(customer.email).trim().slice(0, 200) : '',
    },
    paymentMethod: paymentMethod || 'Razorpay',
    paymentStatus,
    isOutOfRange: !!isOutOfRange,
    location: loc.lat != null ? loc : undefined,
  });
  logger.success('ORDERS', `Order Created: NC-${order.orderNo}`, { orderId: order._id });

  // Update customer summary metrics
  await upsertCustomer({
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    userId: userId || null,
    totalSpent: total,
  });

  for (const li of lineItems) {
    await MenuItem.updateOne({ _id: li.menuItemId }, { $inc: { orderCount: li.quantity } });
  }

  // Deduct inventory items stock
  logger.debug('ORDERS', 'Stock Reserved (Deducting current stock)');
  for (const li of lineItems) {
    const menu = await MenuItem.findById(li.menuItemId).populate('ingredients.inventoryItemId');
    if (!menu || menu.autoInventory !== true) continue;

    for (const ingredient of menu?.ingredients || []) {
      if (!ingredient.inventoryItemId) continue;
      const inventoryItem = ingredient.inventoryItemId;
      const quantityToDeduct = Number(ingredient.quantity || 0) * Number(li.quantity || 1);
      if (!Number.isFinite(quantityToDeduct) || quantityToDeduct <= 0) continue;

      const previousStock = Number(inventoryItem.currentStock || 0);
      const newStock = Math.max(0, previousStock - quantityToDeduct);
      inventoryItem.currentStock = newStock;
      await inventoryItem.save();

      await StockMovement.create({
        inventoryItemId: inventoryItem._id,
        type: 'sale',
        quantity: -quantityToDeduct,
        previousStock,
        newStock,
        reason: 'Order sale',
        referenceId: order._id.toString(),
      });

      // Broadcast stock changes
      await broadcastInventoryStockChange(io, inventoryItem._id);
    }
  }

  if (customer.email) {
    logger.info('ORDERS', `Email Queued to: ${customer.email}`);
    sendOrderConfirmationEmail({
      to: customer.email,
      name: customer.name,
      orderNo: order.orderNo,
      total,
      items: lineItems,
      orderId: order._id,
    }).then(() => {
      logger.success('ORDERS', `Email Sent to: ${customer.email}`);
    }).catch((e) => {
      logger.error('ORDERS', `Email Confirmation Delivery Failed: ${e.message}`, { error: e });
    });
  }

  // WhatsApp confirmation message for all orders
  let targetPhone = customer.phone;
  if (userId) {
    const user = await User.findById(userId);
    if (user && user.phone) targetPhone = user.phone;
  }
  if (targetPhone) {
    try {
      sendPaymentSuccessMessage(targetPhone, customer.name, order.orderNo, order._id, order.trackingToken);
    } catch (e) {
      logger.warn('ORDERS', `WhatsApp confirmation failed: ${e.message}`, { error: e });
    }
  }

  // Emit detailed order info to admins (Kitchen Notified)
  logger.info('ORDERS', 'Socket Broadcast: Kitchen Notified');
  io?.emit('orders:update', {
    type: 'created',
    status: 'Received',
    orderId: order._id,
    orderNo: order.orderNo,
    customerName: customer.name,
    totalPrice: total,
    itemCount: lineItems.length,
    createdAt: order.createdAt,
  });

  // Notify admins via push
  logger.info('ORDERS', 'Customer Notification Sent (Admin Push Queue)');
  sendAdminPushNotification(`New Order #${order.orderNo}`, {
    body: `${customer.name} placed an order for ₹${total}`,
    data: { url: '/admin/orders' },
    tag: 'new-order',
  }).catch(e => logger.error('ORDERS', `Admin Push Notification failed: ${e.message}`, { error: e }));

  logger.success('ORDERS', `Response Returned to Customer: NC-${order.orderNo}`, { orderNo: order.orderNo });
  return { order, trackingToken };
}
