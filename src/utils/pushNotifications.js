import webpush from 'web-push';
import PushSubscription from '../models/PushSubscription.js';
import { logger } from './logger.js';

// Configure web-push with VAPID keys
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = publicKey;
  process.env.VAPID_PRIVATE_KEY = privateKey;
  logger.info('NOTIFICATION', 'Auto-generated VAPID keys for session');
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@nerocafe.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

/**
 * Send push notification to specific subscriptions
 */
export async function sendPushNotification(subscriptions, title, options = {}) {
  const startTime = Date.now();
  if (!subscriptions || subscriptions.length === 0) {
    logger.info('NOTIFICATION', 'No push subscriptions found to notify');
    return;
  }

  const payload = JSON.stringify({
    title,
    body: options.body || '',
    icon: options.icon || '/logo1.png',
    badge: options.badge || '/badge-72x72.png',
    tag: options.tag || 'notification',
    requireInteraction: options.requireInteraction ?? false,
    data: options.data || {},
  });

  const promises = subscriptions.map((sub) => {
    const doc = sub?.toObject ? sub.toObject() : sub;
    const endpoint = doc?.endpoint;
    const auth = doc?.keys?.auth || doc?.auth;
    const p256dh = doc?.keys?.p256dh || doc?.p256dh;

    if (!endpoint || !auth || !p256dh) {
      logger.info('NOTIFICATION', `Invalid push subscription, deleting: ${sub?._id}`, { subId: sub?._id });
      return PushSubscription.deleteOne({ _id: sub?._id || sub?.id || doc?._id }).catch(() => {});
    }

    // Add timeout to prevent hanging
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Push notification timeout')), 5000);
    });

    return Promise.race([
      webpush
        .sendNotification({
          endpoint,
          keys: { auth, p256dh },
        }, payload)
        .catch((err) => {
          // Handle invalid subscriptions (410 Gone)
          if (err.statusCode === 410 || err.statusCode === 404) {
            logger.info('NOTIFICATION', `Push subscription expired/gone, deleting: ${sub?._id}`, { subId: sub?._id });
            return PushSubscription.deleteOne({ _id: sub?._id || sub?.id || doc?._id }).catch(() => {});
          }
          logger.error('NOTIFICATION', `Push notification delivery error: ${err.message}`, { error: err });
        }),
      timeoutPromise
    ]);
  });

  const results = await Promise.allSettled(promises);
  const duration = Date.now() - startTime;
  const succeededCount = results.filter(r => r.status === 'fulfilled').length;
  logger.success('NOTIFICATION', `Push sent to ${subscriptions.length} subscriptions in ${duration}ms (${succeededCount} succeeded)`, {
    duration,
    total: subscriptions.length,
    succeeded: succeededCount,
  });
  return results;
}

/**
 * Send push to all admin subscriptions
 */
export async function sendAdminPushNotification(title, options = {}) {
  const adminSubs = await PushSubscription.find({ isAdmin: true }).lean();
  return sendPushNotification(adminSubs, title, options);
}

/**
 * Send push to a specific user
 */
export async function sendUserPushNotification(userId, title, options = {}) {
  const userSubs = await PushSubscription.find({ userId }).lean();
  return sendPushNotification(userSubs, title, options);
}

/**
 * Save or update push subscription
 */
export async function savePushSubscription(endpoint, auth, p256dh, userId = null, isAdmin = false) {
  try {
    const existing = await PushSubscription.findOneAndUpdate(
      { endpoint },
      {
        auth,
        p256dh,
        userId,
        isAdmin,
        lastActive: new Date(),
      },
      { upsert: true, new: true }
    );
    return existing;
  } catch (err) {
    logger.error('NOTIFICATION', `Save push subscription error: ${err.message}`, { error: err });
    throw err;
  }
}

/**
 * Remove push subscription
 */
export async function removePushSubscription(endpoint) {
  return PushSubscription.deleteOne({ endpoint }).catch(() => {});
}
