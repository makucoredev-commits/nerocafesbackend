import express from 'express';
import { authUser } from '../middleware/authUser.js';
import { authAdmin } from '../middleware/authAdmin.js';
import {
  savePushSubscription,
  removePushSubscription,
} from '../utils/pushNotifications.js';
import PushSubscription from '../models/PushSubscription.js';

const router = express.Router();

/**
 * GET /push/vapid-public-key
 * Get public VAPID key for client subscription
 */
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

/**
 * POST /push/subscribe
 * Subscribe to push notifications (user)
 */
router.post('/subscribe', authUser, async (req, res) => {
  try {
    const { endpoint, auth, p256dh } = req.body;
    if (!endpoint || !auth || !p256dh) {
      return res.status(400).json({ error: 'Missing subscription details' });
    }

    await savePushSubscription(endpoint, auth, p256dh, req.user?._id, false);
    res.json({ success: true, message: 'Subscribed to push notifications' });
  } catch (err) {
    console.error('[Push] Subscribe error:', err.message);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

/**
 * POST /push/unsubscribe
 * Unsubscribe from push notifications
 */
router.post('/unsubscribe', authUser, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: 'Missing endpoint' });
    }

    await removePushSubscription(endpoint);
    res.json({ success: true, message: 'Unsubscribed from push notifications' });
  } catch (err) {
    console.error('[Push] Unsubscribe error:', err.message);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

/**
 * POST /push/admin/subscribe
 * Admin subscribe to push notifications
 */
router.post('/admin/subscribe', authAdmin, async (req, res) => {
  try {
    const { endpoint, auth, p256dh } = req.body;
    if (!endpoint || !auth || !p256dh) {
      return res.status(400).json({ error: 'Missing subscription details' });
    }

    await savePushSubscription(endpoint, auth, p256dh, null, true);
    res.json({ success: true, message: 'Admin subscribed to push notifications' });
  } catch (err) {
    console.error('[Push] Admin subscribe error:', err.message);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

/**
 * POST /push/admin/unsubscribe
 * Admin unsubscribe from push notifications
 */
router.post('/admin/unsubscribe', authAdmin, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: 'Missing endpoint' });
    }

    await removePushSubscription(endpoint);
    res.json({ success: true, message: 'Admin unsubscribed from push notifications' });
  } catch (err) {
    console.error('[Push] Admin unsubscribe error:', err.message);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

/**
 * GET /push/stats
 * Get push subscription stats (admin only)
 */
router.get('/stats', authAdmin, async (req, res) => {
  try {
    const totalSubs = await PushSubscription.countDocuments();
    const adminSubs = await PushSubscription.countDocuments({ isAdmin: true });
    const userSubs = await PushSubscription.countDocuments({ userId: { $exists: true } });

    res.json({ total: totalSubs, admin: adminSubs, users: userSubs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
