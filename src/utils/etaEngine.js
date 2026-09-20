import { Order } from '../models/Order.js';
import { MenuItem } from '../models/MenuItem.js';

/**
 * ETA Calculation Engine
 * Calculates estimated preparation time based on:
 * 1. Menu item preparation times
 * 2. Current kitchen workload (active orders)
 * 3. Chef availability
 */

const ETA_THRESHOLD_MINUTES = 25; // Default threshold for confirmation dialog

/**
 * Calculate base preparation time for order items
 * @param {Array} items - Order items with menuItemId
 * @returns {Promise<number>} Base time in minutes
 */
async function calculateBasePrepTime(items) {
  if (!items || items.length === 0) return 0;

  const menuItemIds = items.map(item => item.menuItemId);
  const menuItems = await MenuItem.find({ _id: { $in: menuItemIds } });
  
  const itemMap = new Map(menuItems.map(item => [item._id.toString(), item]));
  
  let maxPrepTime = 0;
  for (const item of items) {
    const menuItem = itemMap.get(item.menuItemId);
    if (menuItem) {
      const itemTime = (menuItem.preparationTime || 10) * item.quantity;
      maxPrepTime = Math.max(maxPrepTime, itemTime);
    }
  }
  
  return maxPrepTime;
}

/**
 * Get current kitchen workload
 * @returns {Promise<Object>} Workload statistics
 */
async function getKitchenWorkload() {
  const activeOrders = await Order.find({
    status: { $in: ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing'] },
    cancelledAt: null
  });
  
  const totalPendingItems = activeOrders.reduce((sum, order) => {
    return sum + (order.items?.reduce((itemSum, item) => itemSum + item.quantity, 0) || 0);
  }, 0);
  
  const avgPrepTime = activeOrders.length > 0 
    ? activeOrders.reduce((sum, order) => sum + (order.estimatedPrepTime || 10), 0) / activeOrders.length
    : 10;
  
  return {
    activeOrderCount: activeOrders.length,
    totalPendingItems,
    avgPrepTime: Math.round(avgPrepTime),
    estimatedQueueTime: Math.round(activeOrders.length * avgPrepTime * 0.7) // 70% efficiency factor
  };
}

/**
 * Calculate ETA for a new order
 * @param {Array} items - Order items
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} ETA calculation result
 */
async function calculateOrderETA(items, options = {}) {
  const baseTime = await calculateBasePrepTime(items);
  const workload = await getKitchenWorkload();
  
  // Calculate total ETA: base time + queue time
  const totalETA = baseTime + workload.estimatedQueueTime;
  
  const estimatedReadyTime = new Date();
  estimatedReadyTime.setMinutes(estimatedReadyTime.getMinutes() + totalETA);
  
  return {
    basePrepTime: baseTime,
    queueTime: workload.estimatedQueueTime,
    totalETA,
    estimatedReadyTime,
    exceedsThreshold: totalETA > ETA_THRESHOLD_MINUTES,
    workload,
    threshold: ETA_THRESHOLD_MINUTES
  };
}

/**
 * Recalculate ETA for all active orders
 * Called when orders are added, completed, cancelled, or reassigned
 */
async function recalculateAllActiveOrders() {
  const activeOrders = await Order.find({
    status: { $in: ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing'] },
    cancelledAt: null
  }).sort({ createdAt: 1 });
  
  const workload = await getKitchenWorkload();
  
  for (let i = 0; i < activeOrders.length; i++) {
    const order = activeOrders[i];
    const baseTime = await calculateBasePrepTime(order.items);
    
    // Queue position is current index
    const queueTime = i * workload.avgPrepTime * 0.7;
    const totalETA = baseTime + queueTime;
    
    order.estimatedPrepTime = totalETA;
    order.queuePosition = i + 1;
    
    if (['Received', 'Confirmed', 'Queued'].includes(order.status)) {
      const estimatedReadyTime = new Date();
      estimatedReadyTime.setMinutes(estimatedReadyTime.getMinutes() + totalETA);
      order.estimatedReadyTime = estimatedReadyTime;
    }
    
    await order.save();
  }
  
  return activeOrders.length;
}

/**
 * Get kitchen queue for staff view
 * @returns {Promise<Array>} Ordered queue of active orders
 */
async function getKitchenQueue() {
  const orders = await Order.find({
    status: { $in: ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing'] },
    cancelledAt: null
  })
    .populate('chefAssigned', 'name email')
    .sort({ createdAt: 1 });
  
  const now = new Date();
  
  return orders.map(order => {
    const remainingMinutes = order.estimatedReadyTime
      ? Math.max(0, Math.round((new Date(order.estimatedReadyTime) - now) / 60000))
      : order.estimatedPrepTime || 0;
    
    return {
      _id: order._id,
      orderNo: order.orderNo,
      customer: order.customer,
      items: order.items,
      status: order.status,
      estimatedPrepTime: order.estimatedPrepTime,
      estimatedReadyTime: order.estimatedReadyTime,
      remainingTime: remainingMinutes,
      queuePosition: order.queuePosition,
      chefAssigned: order.chefAssigned,
      preparationStartedAt: order.preparationStartedAt,
      createdAt: order.createdAt
    };
  });
}

/**
 * Assign chef to order and update ETA
 * @param {string} orderId - Order ID
 * @param {string} chefId - Admin/Chef ID
 */
async function assignChefToOrder(orderId, chefId) {
  const order = await Order.findById(orderId);
  if (!order) throw new Error('Order not found');
  
  order.chefAssigned = chefId;
  
  if (['Received', 'Confirmed', 'Queued'].includes(order.status) && !order.preparationStartedAt) {
    order.status = 'Preparing';
    order.preparationStartedAt = new Date();
    
    // Recalculate ETA for all orders
    await recalculateAllActiveOrders();
  } else {
    await order.save();
  }
  
  return order;
}

/**
 * Mark order preparation complete
 * @param {string} orderId - Order ID
 */
async function completeOrderPreparation(orderId) {
  const order = await Order.findById(orderId);
  if (!order) throw new Error('Order not found');
  
  order.status = 'Ready';
  order.estimatedReadyTime = new Date();
  
  await order.save();
  
  // Recalculate ETA for remaining orders
  await recalculateAllActiveOrders();
  
  return order;
}

export {
  calculateOrderETA,
  recalculateAllActiveOrders,
  getKitchenQueue,
  assignChefToOrder,
  completeOrderPreparation,
  getKitchenWorkload,
  ETA_THRESHOLD_MINUTES
};
