import { Router } from 'express';
import { SessionPresence } from '../models/SessionPresence.js';
import { BlockedDevice } from '../models/BlockedDevice.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * Lightweight heartbeat handler for customer and admin presence.
 * Called every 15-20s by active frontend clients.
 */
router.post('/heartbeat', async (req, res) => {
  try {
    const {
      sessionId,
      userType = 'CUSTOMER',
      userId = null,
      userLabel = '',
      deviceCategory = 'desktop',
      deviceModel = 'Generic Device',
      browser = 'Unknown Browser',
      browserVersion = '',
      os = 'Unknown OS',
      osVersion = '',
      screenResolution = '',
      city = '',
      region = '',
      country = '',
      locationLabel = '',
      currentPage = '/',
      metadata = {},
    } = req.body;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress || '127.0.0.1';
    const now = new Date();

    const userPhone = String(req.body?.phone || metadata?.phone || '').replace(/\D/g, '');

    // Check if device, IP, session, or user phone is blocked
    const blockQueries = [{ target: ip }, { ip }, { target: sessionId }];
    if (userPhone) {
      blockQueries.push({ target: userPhone }, { phone: userPhone });
      if (userPhone.length === 10) blockQueries.push({ target: `91${userPhone}` }, { phone: `91${userPhone}` });
    }

    const isBlocked = await BlockedDevice.findOne({
      isActive: true,
      $or: blockQueries,
    });

    if (isBlocked) {
      return res.json({
        ok: true,
        revoked: true,
        blocked: true,
        reason: isBlocked.reason || 'Blocked by administrator',
        message: `You have been blocked from using NeroCafes. Reason: ${isBlocked.reason || 'Blocked by administrator'}`,
      });
    }

    const normalizedUserType = userType === 'ADMIN' ? 'ADMIN' : 'CUSTOMER';
    const userRefModel = normalizedUserType === 'ADMIN' ? 'Admin' : 'User';

    const existing = await SessionPresence.findOne({ sessionId });

    if (existing && existing.isRevoked) {
      return res.json({
        ok: true,
        revoked: true,
        message: 'Session has been revoked by Command Center',
      });
    }

    const finalLocationLabel = locationLabel || (city ? `${city}${country ? `, ${country}` : ''}` : existing?.locationLabel || (ip === '127.0.0.1' ? 'Hyderabad / Localhost' : 'India'));

    const sessionDoc = await SessionPresence.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          userType: normalizedUserType,
          userId: userId || existing?.userId || null,
          userRefModel,
          userLabel: userLabel || existing?.userLabel || (normalizedUserType === 'ADMIN' ? 'Admin Operator' : 'Customer Guest'),
          deviceCategory,
          deviceModel: deviceModel || existing?.deviceModel || 'Generic Device',
          browser,
          browserVersion: browserVersion || existing?.browserVersion || '',
          os,
          osVersion: osVersion || existing?.osVersion || '',
          screenResolution: screenResolution || existing?.screenResolution || '',
          city: city || existing?.city || '',
          region: region || existing?.region || '',
          country: country || existing?.country || '',
          locationLabel: finalLocationLabel,
          ip,
          currentPage,
          lastSeenAt: now,
          metadata: { ...metadata, userAgent: req.headers['user-agent'] || '' },
        },
        $setOnInsert: {
          sessionStartTime: now,
          isRevoked: false,
        },
      },
      { upsert: true, new: true }
    );

    // Broadcast presence update to Command Center socket room if available
    const io = req.app.get('io');
    if (io) {
      io.to('command-center').emit('presence:update', {
        sessionId: sessionDoc.sessionId,
        userType: sessionDoc.userType,
        userLabel: sessionDoc.userLabel,
        deviceCategory: sessionDoc.deviceCategory,
        browser: sessionDoc.browser,
        os: sessionDoc.os,
        lastSeenAt: sessionDoc.lastSeenAt,
        currentPage: sessionDoc.currentPage,
        status: 'online',
      });
    }

    return res.json({
      ok: true,
      revoked: false,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    logger.error('PRESENCE', `Heartbeat processing error: ${error.message}`, { error });
    return res.status(500).json({ ok: false, error: 'Failed to record heartbeat' });
  }
});

export default router;
