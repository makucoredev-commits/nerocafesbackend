import { Order } from '../models/Order.js';
import { MenuItem } from '../models/MenuItem.js';

// Priority multipliers for ETA calculation
const PRIORITY_MULTIPLIERS = {
  normal: 1.0,
  high: 0.8, // 20% faster
  urgent: 0.5 // 50% faster
};

// Kitchen station capacity (future-ready)
const STATION_CAPACITY = {
  cooking: 3,
  packing: 2
};

const LIVE_ORDER_STATUSES = ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing', 'Ready'];

/**
 * ETA Engine - Calculates and manages order ETAs based on kitchen workload
 */
class ETAEngine {
  constructor(io) {
    this.io = io;
    this.kitchenQueue = new Map(); // orderId -> queue data
    this.chefWorkload = new Map(); // chefId -> workload data
    this.activeChefs = new Set();
    this.etaThreshold = 25; // minutes
    this.activeChefCount = 2;
  }

  /**
   * Initialize the engine with current orders
   */
  async initialize() {
    const activeOrders = await Order.find({
      status: { $in: LIVE_ORDER_STATUSES },
      cancelledAt: null
    }).sort({ estimatedReadyTime: 1 });

    for (const order of activeOrders) {
      this.kitchenQueue.set(order._id.toString(), {
        order,
        queuePosition: order.queuePosition || 0,
        remainingTime: order.remainingTime || 0
      });

      if (order.chefAssigned) {
        this.assignChefToOrder(order.chefAssigned.toString(), order._id.toString());
      }
    }

    console.log(`[ETA Engine] Initialized with ${activeOrders.length} active orders`);
  }

  /**
   * Update configuration
   */
  updateConfig(config) {
    if (config.etaThreshold !== undefined) this.etaThreshold = config.etaThreshold;
    if (config.activeChefCount !== undefined) this.activeChefCount = config.activeChefCount;
    if (config.activeChefs) {
      this.activeChefs = new Set(config.activeChefs);
    }
  }

  /**
   * Derive a stable prep-time estimate from the order's item metadata.
   */
  getOrderBasePrepTime(order) {
    let totalPrepTime = 0;
    const items = Array.isArray(order?.items) ? order.items : [];

    for (const item of items) {
      const quantity = Math.max(1, Number(item?.quantity) || 1);
      const prepTime = Number(item?.preparationTime);
      const bufferTime = Number(item?.bufferTime);

      const safePrep = Number.isFinite(prepTime) ? prepTime : 8;
      const safeBuffer = Number.isFinite(bufferTime) ? bufferTime : 2;
      totalPrepTime += (safePrep + safeBuffer) * quantity;
    }

    return Math.max(6, Math.ceil(totalPrepTime || 0));
  }

  /**
   * Calculate ETA for a new order
   */
  async calculateOrderETA(order) {
    const now = new Date();
    let totalPrepTime = 0;
    let itemCount = 0;

    // Calculate preparation time for all items
    for (const item of order.items) {
      const menuItem = await MenuItem.findById(item.menuItemId);
      if (menuItem) {
        const prepTime = Number.isFinite(item.preparationTime)
          ? item.preparationTime
          : (menuItem.preparationTime || 10);
        const bufferTime = Number.isFinite(item.bufferTime)
          ? item.bufferTime
          : (menuItem.bufferTime || 2);
        const itemTime = (prepTime + bufferTime) * item.quantity;
        totalPrepTime += itemTime;
      } else {
        totalPrepTime += 12 * item.quantity;
      }
      itemCount += item.quantity || 0;
    }

    // Apply priority multiplier
    const priorityMultiplier = PRIORITY_MULTIPLIERS[order.priority] || 1.0;
    const basePrepTime = Math.max(6, Math.ceil(totalPrepTime * priorityMultiplier));

    // Calculate queue wait time from active workload
    const queueWaitTime = await this.calculateQueueWaitTime(order);
    const activeOrders = await Order.find({
      status: { $in: LIVE_ORDER_STATUSES },
      cancelledAt: null,
      _id: { $ne: order._id }
    }).sort({ createdAt: 1 });

    const currentQueue = activeOrders.length;
    const averageQueuedPrep = activeOrders.length > 0
      ? activeOrders.reduce((sum, activeOrder) => sum + this.getOrderBasePrepTime(activeOrder), 0) / activeOrders.length
      : 0;
    const workloadFactor = 1 + Math.min(0.8, (currentQueue / Math.max(1, this.activeChefCount || 2)) * 0.15);
    const itemDensityFactor = 1 + Math.min(0.35, Math.max(0, itemCount - 1) * 0.04);
    const dynamicWait = Math.ceil((queueWaitTime + averageQueuedPrep * 0.35) * workloadFactor * itemDensityFactor);

    // Total ETA
    const totalETA = Math.max(6, Math.ceil(basePrepTime + dynamicWait));

    // Calculate estimated ready time
    const estimatedReadyTime = new Date(now.getTime() + totalETA * 60000);

    return {
      estimatedPrepTime: basePrepTime,
      queueWaitTime: dynamicWait,
      totalETA,
      estimatedReadyTime,
      remainingTime: totalETA,
      currentQueue,
      kitchenLoad: this.getLoadProfile(currentQueue)
    };
  }

  /**
   * Calculate queue wait time based on current kitchen workload
   */
  async calculateQueueWaitTime(newOrder) {
    const activeOrders = await Order.find({
      status: { $in: LIVE_ORDER_STATUSES },
      cancelledAt: null,
      _id: { $ne: newOrder._id }
    }).sort({ createdAt: 1 });

    let totalWaitTime = 0;
    for (const order of activeOrders) {
      const remainingTime = await this.getOrderRemainingTime(order);
      totalWaitTime += remainingTime;
    }

    const effectiveChefs = Math.max(1, this.activeChefCount);
    const queuePressure = Math.max(0, activeOrders.length - effectiveChefs);
    return Math.ceil((totalWaitTime / effectiveChefs) + (queuePressure * 2));
  }

  /**
   * Get remaining time for an order based on its status
   */
  async getOrderRemainingTime(order) {
    const now = new Date();
    const effectivePrepTime = Math.max(order.estimatedPrepTime || 0, this.getOrderBasePrepTime(order));

    switch (order.status) {
      case 'Received':
      case 'Confirmed':
      case 'Queued':
        return effectivePrepTime;

      case 'Preparing':
        if (order.preparationStartedAt) {
          const elapsed = (now - order.preparationStartedAt) / 60000; // minutes
          return Math.max(0, effectivePrepTime - elapsed);
        }
        return effectivePrepTime;

      case 'Cooking':
        if (order.cookingStartedAt) {
          const elapsed = (now - order.cookingStartedAt) / 60000;
          return Math.max(0, 10 - elapsed); // Assume 10 min cooking time
        }
        return 10;

      case 'Packing':
        if (order.packingStartedAt) {
          const elapsed = (now - order.packingStartedAt) / 60000;
          return Math.max(0, 5 - elapsed); // Assume 5 min packing time
        }
        return 5;

      case 'Ready':
      case 'Completed':
      case 'Cancelled':
        return 0;

      default:
        return effectivePrepTime;
    }
  }

  /**
   * Recalculate ETA for an order and affected orders
   */
  async recalculateETA(orderId, trigger = 'manual') {
    const order = await Order.findById(orderId);
    if (!order) return;

    const etaData = await this.calculateOrderETA(order);

    // Update order
    order.estimatedPrepTime = etaData.estimatedPrepTime;
    order.estimatedReadyTime = etaData.estimatedReadyTime;
    order.remainingTime = etaData.remainingTime;
    order.etaRecalculatedAt = new Date();
    await order.save();

    // Update queue
    this.kitchenQueue.set(orderId, {
      order,
      queuePosition: await this.getQueuePosition(order),
      remainingTime: etaData.remainingTime
    });

    // Emit update to relevant rooms
    this.emitETAUpdate(order, etaData, trigger);

    // Check if ETA exceeds threshold
    if (etaData.totalETA > this.etaThreshold && !order.longEtaAcknowledged) {
      this.emitLongETAWarning(order, etaData);
    }

    console.log(`[ETA Engine] Recalculated ETA for Order #${order.orderNo}: ${etaData.totalETA}min (trigger: ${trigger})`);

    return etaData;
  }

  /**
   * Recalculate ETAs for all affected orders after a status change
   */
  async recalculateAffectedOrders(excludeOrderId = null) {
    const activeOrders = await Order.find({
      status: { $in: ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing'] },
      cancelledAt: null,
      _id: { $ne: excludeOrderId }
    }).sort({ createdAt: 1 });

    for (const order of activeOrders) {
      await this.recalculateETA(order._id.toString(), 'batch');
    }

    console.log(`[ETA Engine] Recalculated ${activeOrders.length} affected orders`);
  }

  /**
   * Get queue position for an order
   */
  async getQueuePosition(order) {
    if (['Ready', 'Completed', 'Cancelled'].includes(order.status)) {
      return 0;
    }

    const position = await Order.countDocuments({
      status: { $in: LIVE_ORDER_STATUSES },
      cancelledAt: null,
      createdAt: { $lt: order.createdAt }
    });

    return position + 1;
  }

  /**
   * Assign chef to order
   */
  assignChefToOrder(chefId, orderId) {
    if (!this.chefWorkload.has(chefId)) {
      this.chefWorkload.set(chefId, {
        orders: new Set(),
        totalRemainingTime: 0
      });
    }

    const workload = this.chefWorkload.get(chefId);
    workload.orders.add(orderId);
    this.activeChefs.add(chefId);
  }

  /**
   * Remove chef from order
   */
  removeChefFromOrder(chefId, orderId) {
    const workload = this.chefWorkload.get(chefId);
    if (workload) {
      workload.orders.delete(orderId);
      if (workload.orders.size === 0) {
        this.chefWorkload.delete(chefId);
        this.activeChefs.delete(chefId);
      }
    }
  }

  /**
   * Get chef workload
   */
  getChefWorkload(chefId) {
    return this.chefWorkload.get(chefId) || { orders: new Set(), totalRemainingTime: 0 };
  }

  /**
   * Get kitchen utilization
   */
  getKitchenUtilization() {
    const totalOrders = this.kitchenQueue.size;
    const totalChefs = this.activeChefs.size || 1;
    return Math.min(100, Math.round((totalOrders / (totalChefs * 5)) * 100)); // Assume 5 orders per chef max
  }

  /**
   * Normalize kitchen load into a friendly status label and percentage
   */
  getLoadProfile(activeOrderCount) {
    const count = Math.max(0, Number(activeOrderCount) || 0);

    if (count <= 5) {
      return { label: 'Low Load', percent: Math.min(100, Math.round((count / 5) * 100)), tone: 'low' };
    }
    if (count <= 12) {
      return { label: 'Medium', percent: Math.min(100, Math.round((count / 12) * 100)), tone: 'medium' };
    }
    if (count <= 20) {
      return { label: 'Busy', percent: Math.min(100, Math.round((count / 20) * 100)), tone: 'busy' };
    }

    return { label: 'Very Busy', percent: 100, tone: 'veryBusy' };
  }

  /**
   * Return a reusable admin workload snapshot for the dashboard cards
   */
  async getKitchenSnapshot() {
    const activeOrders = await Order.find({
      status: { $in: LIVE_ORDER_STATUSES },
      cancelledAt: null
    }).sort({ createdAt: 1 });

    const queueSize = activeOrders.length;
    const averagePrepTime = queueSize > 0
      ? Math.round(activeOrders.reduce((sum, order) => sum + this.getOrderBasePrepTime(order), 0) / queueSize)
      : null;
    const averageWait = queueSize > 0
      ? Math.round(activeOrders.reduce((sum, order) => sum + Math.max(0, order.remainingTime || this.getOrderBasePrepTime(order)), 0) / queueSize)
      : null;
    const oldestOrder = activeOrders[0] || null;
    const estimatedCompletionTime = oldestOrder?.estimatedReadyTime || (queueSize > 0 ? new Date(Date.now() + Math.max(averageWait || 0, averagePrepTime || 0) * 60000) : null);
    const loadProfile = this.getLoadProfile(queueSize);

    return {
      currentQueue: queueSize,
      currentActiveOrders: queueSize,
      averagePrepTime,
      kitchenLoad: loadProfile.label,
      kitchenLoadPercent: loadProfile.percent,
      estimatedCompletionTime,
      ordersWaiting: queueSize,
      averageWait,
      queueStatus: loadProfile
    };
  }

  /**
   * Get today's business metrics for live dashboard
   */
  async getTodayMetrics() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Today's completed orders (revenue)
    const completedOrders = await Order.find({
      status: 'Completed',
      cancelledAt: null,
      createdAt: { $gte: todayStart, $lte: todayEnd }
    });

    const todayRevenue = completedOrders.reduce((sum, order) => sum + (order.totalPrice || 0), 0);

    // Today's pending orders (potential revenue)
    const pendingOrders = await Order.find({
      status: { $in: LIVE_ORDER_STATUSES },
      cancelledAt: null,
      createdAt: { $gte: todayStart, $lte: todayEnd }
    });

    const pendingRevenue = pendingOrders.reduce((sum, order) => sum + (order.totalPrice || 0), 0);

    // Estimate cost (assuming ~60% of revenue is cost for food business)
    const estimatedCost = Math.round(todayRevenue * 0.6);
    const estimatedProfit = todayRevenue - estimatedCost;

    return {
      todayRevenue: Math.round(todayRevenue),
      pendingRevenue: Math.round(pendingRevenue),
      estimatedCost,
      estimatedProfit,
      completedOrdersCount: completedOrders.length,
      pendingOrdersCount: pendingOrders.length,
      totalOrdersToday: completedOrders.length + pendingOrders.length,
      date: todayStart.toISOString().split('T')[0]
    };
  }

  /**
   * Emit ETA update via Socket.IO
   */
  emitETAUpdate(order, etaData, trigger) {
    const updateData = {
      orderId: order._id.toString(),
      orderNo: order.orderNo,
      status: order.status,
      estimatedReadyTime: order.estimatedReadyTime,
      remainingTime: order.remainingTime,
      queuePosition: order.queuePosition,
      trigger
    };

    const customerRoom = order.userId ? `customer:${order.userId.toString()}` : `customer:${order._id.toString()}`;

    // Emit to order-specific room (customer view)
    this.io.to(`order:${order._id.toString()}`).emit('eta:update', updateData);
    this.io.to(customerRoom).emit('eta:update', updateData);

    // Emit to user room (customer's other devices)
    if (order.userId) {
      this.io.to(`user:${order.userId.toString()}`).emit('eta:update', updateData);
    }

    // Emit to admin/kitchen rooms
    this.io.to('admin').emit('kitchen:eta:update', updateData);
    this.io.to('kitchen').emit('kitchen:eta:update', updateData);
  }

  /**
   * Emit long ETA warning
   */
  emitLongETAWarning(order, etaData) {
    const warningData = {
      orderId: order._id.toString(),
      orderNo: order.orderNo,
      eta: etaData.totalETA,
      threshold: this.etaThreshold,
      message: `This order will take approximately ${etaData.totalETA} minutes because of current kitchen demand.`
    };

    this.io.to(`order:${order._id.toString()}`).emit('eta:long', warningData);
    if (order.userId) {
      this.io.to(`user:${order.userId.toString()}`).emit('eta:long', warningData);
    }
  }

  /**
   * Handle order status change
   */
  async handleOrderStatusChange(orderId, newStatus, oldStatus) {
    const order = await Order.findById(orderId);
    if (!order) return;

    const now = new Date();

    // Update timestamps based on status
    switch (newStatus) {
      case 'Preparing':
        if (!order.preparationStartedAt) {
          order.preparationStartedAt = now;
        }
        break;
      case 'Cooking':
        if (!order.cookingStartedAt) {
          order.cookingStartedAt = now;
        }
        break;
      case 'Packing':
        if (!order.packingStartedAt) {
          order.packingStartedAt = now;
        }
        break;
      case 'Ready':
        if (!order.readyAt) {
          order.readyAt = now;
        }
        order.remainingTime = 0;
        break;
      case 'Completed':
      case 'Cancelled':
        order.remainingTime = 0;
        this.kitchenQueue.delete(orderId);
        if (order.chefAssigned) {
          this.removeChefFromOrder(order.chefAssigned.toString(), orderId);
        }
        break;
    }

    await order.save();

    // Recalculate ETA for this order
    await this.recalculateETA(orderId, 'status_change');

    // Recalculate affected orders
    await this.recalculateAffectedOrders(orderId);

    // Emit status update
    this.emitStatusUpdate(order, newStatus, oldStatus);
  }

  /**
   * Emit status update
   */
  emitStatusUpdate(order, newStatus, oldStatus) {
    const updateData = {
      orderId: order._id.toString(),
      orderNo: order.orderNo,
      oldStatus,
      newStatus,
      status: newStatus, // For compatibility with existing client code
      timestamp: new Date()
    };

    const customerRoom = order.userId ? `customer:${order.userId.toString()}` : `customer:${order._id.toString()}`;

    // Emit to order-specific room (customer tracking page)
    this.io.to(`order:${order._id.toString()}`).emit('order:status', updateData);
    this.io.to(`order:${order._id.toString()}`).emit('order:status:update', updateData);
    
    // Emit to customer room
    this.io.to(customerRoom).emit('order:status', updateData);
    this.io.to(customerRoom).emit('order:status:update', updateData);
    
    // Emit to user room (customer's other devices)
    if (order.userId) {
      this.io.to(`user:${order.userId.toString()}`).emit('order:status', updateData);
      this.io.to(`user:${order.userId.toString()}`).emit('order:status:update', updateData);
    }
    
    // Emit to admin/kitchen rooms
    this.io.to('admin').emit('order:status:update', updateData);
    this.io.to('kitchen').emit('order:status:update', updateData);
    
    // Emit global orders update for dashboard refresh
    this.io.emit('orders:update', { type: 'status', orderId: order._id.toString(), status: newStatus });
  }

  /**
   * Get kitchen queue for dashboard
   */
  async getKitchenQueue() {
    const orders = await Order.find({
      status: { $in: ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing'] },
      cancelledAt: null
    })
    .populate('chefAssigned', 'name email')
    .sort({ estimatedReadyTime: 1 });

    return orders.map(order => ({
      orderId: order._id.toString(),
      orderNo: order.orderNo,
      status: order.status,
      priority: order.priority,
      items: order.items,
      estimatedReadyTime: order.estimatedReadyTime,
      remainingTime: order.remainingTime,
      queuePosition: order.queuePosition,
      chefAssigned: order.chefAssigned ? {
        id: order.chefAssigned._id.toString(),
        name: order.chefAssigned.name
      } : null,
      createdAt: order.createdAt
    }));
  }

  /**
   * Get chef assignments
   */
  getChefAssignments() {
    const assignments = [];
    for (const [chefId, workload] of this.chefWorkload.entries()) {
      assignments.push({
        chefId,
        orderCount: workload.orders.size,
        orderIds: Array.from(workload.orders)
      });
    }
    return assignments;
  }
}

// Singleton instance
let etaEngineInstance = null;

/**
 * Get or create ETA engine instance
 */
export function getETAEngine(io) {
  if (!etaEngineInstance) {
    etaEngineInstance = new ETAEngine(io);
  }
  return etaEngineInstance;
}

export default ETAEngine;
