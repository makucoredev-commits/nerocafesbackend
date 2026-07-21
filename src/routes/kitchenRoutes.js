import { Router } from 'express';
import { Order } from '../models/Order.js';
import { authAdmin } from '../middleware/authAdmin.js';
import { sendOrderStatusEmail } from '../utils/emailPlaceholder.js';
import { logger } from '../utils/logger.js';

const router = Router();

// All routes require admin authentication
router.use(authAdmin);

/**
 * Get kitchen queue with all active orders
 */
router.get('/queue', async (req, res) => {
  try {
    const etaEngine = req.app.get('etaEngine');
    const queue = await etaEngine.getKitchenQueue();
    res.json({ queue });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Get chef assignments
 */
router.get('/chefs', async (req, res) => {
  try {
    const etaEngine = req.app.get('etaEngine');
    const assignments = etaEngine.getChefAssignments();
    const utilization = etaEngine.getKitchenUtilization();
    res.json({ assignments, utilization });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Update order status
 */
router.patch('/orders/:orderId/status', async (req, res) => {
  try {
    const { status, chefId } = req.body;
    const orderId = req.params.orderId;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const validStatuses = ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing', 'Ready', 'Completed', 'Cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const oldStatus = order.status;
    order.status = status;

    // Handle chef assignment
    if (chefId && ['Preparing', 'Cooking', 'Packing'].includes(status)) {
      order.chefAssigned = chefId;
      const etaEngine = req.app.get('etaEngine');
      etaEngine.assignChefToOrder(chefId, orderId);
    }

    await order.save();

    // Trigger ETA engine status change handler
    const etaEngine = req.app.get('etaEngine');
    await etaEngine.handleOrderStatusChange(orderId, status, oldStatus);

    // etaEngine.handleOrderStatusChange already emitted order:status and orders:update socket events above

    // Email notification for meaningful transitions
    if (order.customer?.email && status !== oldStatus) {
      sendOrderStatusEmail({
        to: order.customer.email,
        name: order.customer.name || 'Customer',
        orderNo: order.orderNo,
        status,
        orderId: order._id,
      }).catch(e => logger.warn('EMAIL', `Kitchen status email failed: ${e.message}`, { error: e }));
    }

    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Assign chef to order
 */
router.patch('/orders/:orderId/chef', async (req, res) => {
  try {
    const { chefId } = req.body;
    const orderId = req.params.orderId;

    if (!chefId) {
      return res.status(400).json({ error: 'Chef ID is required' });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Remove from previous chef if any
    if (order.chefAssigned) {
      const etaEngine = req.app.get('etaEngine');
      etaEngine.removeChefFromOrder(order.chefAssigned.toString(), orderId);
    }

    order.chefAssigned = chefId;
    await order.save();

    // Assign to new chef
    const etaEngine = req.app.get('etaEngine');
    etaEngine.assignChefToOrder(chefId, orderId);

    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Update order priority
 */
router.patch('/orders/:orderId/priority', async (req, res) => {
  try {
    const { priority } = req.body;
    const orderId = req.params.orderId;

    if (!priority || !['normal', 'high', 'urgent'].includes(priority)) {
      return res.status(400).json({ error: 'Valid priority (normal, high, urgent) is required' });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    order.priority = priority;
    await order.save();

    // Recalculate ETA with new priority
    const etaEngine = req.app.get('etaEngine');
    await etaEngine.recalculateETA(orderId, 'priority_change');

    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Manually override ETA
 */
router.patch('/orders/:orderId/eta', async (req, res) => {
  try {
    const { eta, reason } = req.body;
    const orderId = req.params.orderId;

    if (!eta || eta < 0) {
      return res.status(400).json({ error: 'Valid ETA (in minutes) is required' });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const now = new Date();
    order.estimatedPrepTime = eta;
    order.estimatedReadyTime = new Date(now.getTime() + eta * 60000);
    order.remainingTime = eta;
    order.etaRecalculatedAt = now;
    await order.save();

    // Update ETA engine
    const etaEngine = req.app.get('etaEngine');
    etaEngine.kitchenQueue.set(orderId, {
      order,
      queuePosition: order.queuePosition,
      remainingTime: eta
    });

    // Emit update
    etaEngine.emitETAUpdate(order, {
      estimatedPrepTime: eta,
      estimatedReadyTime: order.estimatedReadyTime,
      remainingTime: eta,
      totalETA: eta
    }, 'manual_override');

    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Acknowledge long ETA
 */
router.post('/orders/:orderId/acknowledge-eta', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const order = await Order.findById(orderId);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    order.longEtaAcknowledged = true;
    await order.save();

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Get ETA engine statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const etaEngine = req.app.get('etaEngine');
    const snapshot = await etaEngine.getKitchenSnapshot();
    const stats = {
      queueSize: etaEngine.kitchenQueue.size,
      activeChefs: etaEngine.activeChefs.size,
      utilization: etaEngine.getKitchenUtilization(),
      etaThreshold: etaEngine.etaThreshold,
      activeChefCount: etaEngine.activeChefCount,
      ...snapshot
    };
    res.json({ stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Get complete workload snapshot with today's business metrics
 */
router.get('/workload', async (req, res) => {
  try {
    const etaEngine = req.app.get('etaEngine');
    const snapshot = await etaEngine.getKitchenSnapshot();
    const todayMetrics = await etaEngine.getTodayMetrics();
    
    const workload = {
      kitchen: {
        queueSize: etaEngine.kitchenQueue.size,
        activeChefs: etaEngine.activeChefs.size,
        utilization: etaEngine.getKitchenUtilization(),
        etaThreshold: etaEngine.etaThreshold,
        activeChefCount: etaEngine.activeChefCount,
        ...snapshot
      },
      business: todayMetrics
    };
    
    res.json({ workload });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Update ETA engine configuration
 */
router.patch('/config', async (req, res) => {
  try {
    const { etaThreshold, activeChefCount, activeChefs } = req.body;
    
    const etaEngine = req.app.get('etaEngine');
    etaEngine.updateConfig({
      etaThreshold,
      activeChefCount,
      activeChefs
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
