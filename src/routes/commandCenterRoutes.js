import { Router } from 'express';
import os from 'os';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { Admin } from '../models/Admin.js';
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';
import { AuditLog } from '../models/AuditLog.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { SessionPresence } from '../models/SessionPresence.js';
import { ShopSettings, getOrCreateShopSettings } from '../models/ShopSettings.js';
import { MenuItem } from '../models/MenuItem.js';
import { authAdmin } from '../middleware/authAdmin.js';
import { getHealthMonitor } from '../utils/healthMonitor.js';
import { logger } from '../utils/logger.js';
import { sendAdminPushNotification, sendUserPushNotification } from '../utils/pushNotifications.js';

const router = Router();

// In-memory tracker for failed Admin panel login attempts (/admin/login)
const adminFailedLoginTracker = {
  attempts: [],
  recentFailures: 0,
  lastResetAt: new Date(),
};

// In-memory tracker for failed Command Center terminal login attempts
const ccFailedLoginTracker = {
  attempts: [],
  recentFailures: 0,
  lastResetAt: new Date(),
};

export function recordFailedAdminLogin(email, ip, reason = 'Invalid credentials') {
  const failure = {
    email: email || 'unknown',
    ip: ip || 'unknown',
    timestamp: new Date(),
    reason,
  };
  adminFailedLoginTracker.attempts.unshift(failure);
  if (adminFailedLoginTracker.attempts.length > 200) {
    adminFailedLoginTracker.attempts = adminFailedLoginTracker.attempts.slice(0, 200);
  }
  adminFailedLoginTracker.recentFailures++;

  // Log in AuditLog
  AuditLog.create({
    action: 'FAILED_ADMIN_LOGIN',
    userType: 'admin',
    actorName: email || 'Unknown',
    target: 'Admin Web Portal Auth Gateway',
    ip,
    userAgent: 'Unknown',
    path: '/api/admin/login',
    method: 'POST',
    status: 401,
    success: false,
    body: { email, reason, gateway: 'WEB_ADMIN' },
    timestamp: new Date(),
  }).catch((err) => logger.error('SECURITY', `Failed to audit failed admin login: ${err.message}`));
}

export function recordFailedCCLogin(email, ip, reason = 'Invalid credentials') {
  const failure = {
    email: email || 'unknown',
    ip: ip || 'unknown',
    timestamp: new Date(),
    reason,
  };
  ccFailedLoginTracker.attempts.unshift(failure);
  if (ccFailedLoginTracker.attempts.length > 200) {
    ccFailedLoginTracker.attempts = ccFailedLoginTracker.attempts.slice(0, 200);
  }
  ccFailedLoginTracker.recentFailures++;

  // Log in AuditLog
  AuditLog.create({
    action: 'FAILED_CC_LOGIN',
    userType: 'admin',
    actorName: email || 'Unknown',
    target: 'Command Center Terminal Gateway',
    ip,
    userAgent: 'CLI',
    path: '/api/command-center/login',
    method: 'POST',
    status: 401,
    success: false,
    body: { email, reason, gateway: 'TERMINAL_CLI' },
    timestamp: new Date(),
  }).catch((err) => logger.error('SECURITY', `Failed to audit failed CC login: ${err.message}`));
}

/**
 * 1. COMMAND CENTER LOGIN / AUTH VERIFY
 */
router.post('/auth/verify', authAdmin, async (req, res) => {
  try {
    return res.json({
      ok: true,
      operator: {
        id: req.admin._id,
        name: req.admin.name,
        email: req.admin.email,
        role: 'OWNER_OPERATOR',
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * 2. OVERVIEW DASHBOARD TELEMETRY
 */
router.get('/overview', authAdmin, async (req, res) => {
  try {
    const healthMonitor = getHealthMonitor();
    const healthData = healthMonitor.getHealthStatus();

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const now = new Date();
    const fifteenSecAgo = new Date(now.getTime() - 15 * 1000);
    const oneMinAgo = new Date(now.getTime() - 60 * 1000);

    // Run parallel database queries for speed and efficiency
    const [
      ordersToday,
      activeSessionsCustomer,
      activeSessionsAdmin,
      totalSessions,
      recentUsers,
      activeTokensCount,
      shopSettings,
    ] = await Promise.all([
      // Orders today aggregated
      Order.aggregate([
        { $match: { createdAt: { $gte: startOfToday } } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            revenue: {
              $sum: {
                $cond: [{ $in: ['$paymentStatus', ['Completed', 'Pending', 'Cash Pending']] }, '$totalPrice', 0],
              },
            },
          },
        },
      ]),
      // Active sessions count (last seen < 60s)
      SessionPresence.countDocuments({
        userType: 'CUSTOMER',
        lastSeenAt: { $gte: oneMinAgo },
        isRevoked: false,
      }),
      SessionPresence.countDocuments({
        userType: 'ADMIN',
        lastSeenAt: { $gte: oneMinAgo },
        isRevoked: false,
      }),
      SessionPresence.countDocuments({
        lastSeenAt: { $gte: oneMinAgo },
        isRevoked: false,
      }),
      // Recent active users
      User.find({}).sort({ updatedAt: -1 }).limit(5).select('name email phone updatedAt createdAt').lean(),
      // Active admin refresh tokens
      RefreshToken.countDocuments({ userType: 'admin', expiresAt: { $gt: now } }),
      // Settings
      getOrCreateShopSettings(),
    ]);

    // Format order counts by status
    const orderStats = {
      totalToday: 0,
      active: 0,
      received: 0,
      confirmed: 0,
      preparing: 0,
      ready: 0,
      completed: 0,
      cancelled: 0,
      totalRevenueToday: 0,
    };

    ordersToday.forEach((group) => {
      const count = group.count || 0;
      orderStats.totalToday += count;
      orderStats.totalRevenueToday += group.revenue || 0;

      const st = String(group._id).toLowerCase();
      if (st === 'received') {
        orderStats.received += count;
        orderStats.active += count;
      } else if (st === 'confirmed') {
        orderStats.confirmed += count;
        orderStats.active += count;
      } else if (st === 'preparing' || st === 'cooking' || st === 'queued' || st === 'packing') {
        orderStats.preparing += count;
        orderStats.active += count;
      } else if (st === 'ready') {
        orderStats.ready += count;
        orderStats.active += count;
      } else if (st === 'completed') {
        orderStats.completed += count;
      } else if (st === 'cancelled') {
        orderStats.cancelled += count;
      }
    });

    const recentSecurityEvents = await AuditLog.find({
      action: { $in: ['FAILED_LOGIN', 'LOGIN', 'LOGOUT', 'RESET_LOGIN_ATTEMPTS', 'SESSION_REVOKE', 'SETTINGS_UPDATE'] },
    })
      .sort({ timestamp: -1 })
      .limit(6)
      .lean();

    return res.json({
      ok: true,
      timestamp: now.toISOString(),
      server: {
        status: healthData.status,
        apiHealth: healthData.metrics?.api?.errorRate < 5 ? 'healthy' : 'degraded',
        dbHealth: mongoose.connection.readyState === 1 ? 'healthy' : 'offline',
        uptimeSeconds: Math.floor(process.uptime()),
        systemUptimeSeconds: Math.floor(os.uptime()),
        cpuUsagePercent: Math.round(healthData.metrics?.cpu?.usage || 0),
        ramUsedMB: healthData.metrics?.memory?.usedMB || Math.round((os.totalmem() - os.freemem()) / (1024 * 1024)),
        ramTotalMB: healthData.metrics?.memory?.totalMB || Math.round(os.totalmem() / (1024 * 1024)),
        ramUsagePercent: Math.round(healthData.metrics?.memory?.usage || 0),
        appVersion: process.env.npm_package_version || '1.0.0',
        environment: process.env.NODE_ENV || 'production',
        nodeVersion: process.version,
      },
      users: {
        activeCustomerSessions: activeSessionsCustomer,
        activeAdminSessions: activeSessionsAdmin,
        totalActiveSessions: totalSessions,
        recentUsers,
      },
      orders: orderStats,
      security: {
        failedLoginAttemptsCount: adminFailedLoginTracker.attempts.length + ccFailedLoginTracker.attempts.length,
        failedAdminLoginAttemptsCount: adminFailedLoginTracker.attempts.length,
        failedCCLoginAttemptsCount: ccFailedLoginTracker.attempts.length,
        activeAdminSessionsCount: activeTokensCount,
        recentSecurityEvents,
        lockedAccountsCount: 0,
      },
      controls: {
        shopOpen: shopSettings.shopOpen,
        maintenanceMode: shopSettings.maintenanceMode,
        holidayMode: shopSettings.holidayMode,
      },
    });
  } catch (error) {
    logger.error('COMMAND_CENTER', `Overview telemetry failed: ${error.message}`, { error });
    return res.status(500).json({ error: 'Failed to aggregate overview telemetry' });
  }
});

/**
 * 3. LIVE ORDER CENTER
 */
router.get('/orders', authAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 30,
      status,
      paymentStatus,
      search,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    const query = {};

    if (status && status !== 'ALL') {
      const statuses = status.split(',').map((s) => s.trim());
      query.status = { $in: statuses };
    }

    if (paymentStatus && paymentStatus !== 'ALL') {
      query.paymentStatus = paymentStatus;
    }

    if (search && search.trim()) {
      const s = search.trim();
      const sNum = Number(s);
      if (!isNaN(sNum)) {
        query.$or = [
          { orderNo: sNum },
          { 'customer.phone': { $regex: s, $options: 'i' } },
          { 'customer.name': { $regex: s, $options: 'i' } },
        ];
      } else {
        query.$or = [
          { 'customer.name': { $regex: s, $options: 'i' } },
          { 'customer.phone': { $regex: s, $options: 'i' } },
          { 'customer.email': { $regex: s, $options: 'i' } },
          { trackingToken: { $regex: s, $options: 'i' } },
        ];
      }
    }

    const sortOption = {};
    sortOption[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const skip = (Number(page) - 1) * Number(limit);

    const [orders, total] = await Promise.all([
      Order.find(query)
        .sort(sortOption)
        .skip(skip)
        .limit(Number(limit))
        .populate('chefAssigned', 'name email')
        .lean(),
      Order.countDocuments(query),
    ]);

    return res.json({
      ok: true,
      orders,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    logger.error('COMMAND_CENTER', `Live orders query failed: ${error.message}`, { error });
    return res.status(500).json({ error: 'Failed to fetch live orders' });
  }
});

/**
 * Single Order Detail with Timeline
 */
router.get('/orders/:id', authAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('chefAssigned', 'name email')
      .populate('userId', 'name email phone')
      .lean();

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Build timeline events from timestamps
    const timeline = [];
    if (order.createdAt) timeline.push({ event: 'Order Received', timestamp: order.createdAt, stage: 'received' });
    if (order.preparationStartedAt) timeline.push({ event: 'Kitchen Preparation Started', timestamp: order.preparationStartedAt, stage: 'preparing' });
    if (order.cookingStartedAt) timeline.push({ event: 'Cooking Started', timestamp: order.cookingStartedAt, stage: 'cooking' });
    if (order.packingStartedAt) timeline.push({ event: 'Packing Started', timestamp: order.packingStartedAt, stage: 'packing' });
    if (order.readyAt) timeline.push({ event: 'Order Ready for Pickup', timestamp: order.readyAt, stage: 'ready' });
    if (order.status === 'Completed') timeline.push({ event: 'Order Completed', timestamp: order.updatedAt, stage: 'completed' });
    if (order.cancelledAt) timeline.push({ event: `Order Cancelled (${order.cancellationReason || 'No reason provided'})`, timestamp: order.cancelledAt, stage: 'cancelled' });

    return res.json({
      ok: true,
      order,
      timeline,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * 4. LIVE DEVICE & SESSION MONITOR
 */
router.get('/devices', authAdmin, async (req, res) => {
  try {
    const now = new Date();
    // Return sessions active within the last 24 hours
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const sessions = await SessionPresence.find({
      lastSeenAt: { $gte: since },
    })
      .sort({ lastSeenAt: -1 })
      .limit(100)
      .lean();

    const formattedSessions = sessions.map((s) => {
      const diffSeconds = Math.floor((now.getTime() - new Date(s.lastSeenAt).getTime()) / 1000);
      let status = 'offline';
      if (s.isRevoked) {
        status = 'revoked';
      } else if (diffSeconds <= 15) {
        status = 'online';
      } else if (diffSeconds <= 60) {
        status = 'idle';
      }

      return {
        ...s,
        status,
        lastSeenSecondsAgo: diffSeconds,
      };
    });

    const customerDevices = formattedSessions.filter((s) => s.userType === 'CUSTOMER');
    const adminDevices = formattedSessions.filter((s) => s.userType === 'ADMIN');

    return res.json({
      ok: true,
      summary: {
        totalActiveOnline: formattedSessions.filter((s) => s.status === 'online').length,
        totalIdle: formattedSessions.filter((s) => s.status === 'idle').length,
        customerCount: customerDevices.length,
        adminCount: adminDevices.length,
      },
      customerDevices,
      adminDevices,
    });
  } catch (error) {
    logger.error('COMMAND_CENTER', `Live devices query failed: ${error.message}`, { error });
    return res.status(500).json({ error: 'Failed to fetch device presence' });
  }
});

/**
 * Revoke specific device session
 */
router.post('/devices/:sessionId/revoke', authAdmin, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await SessionPresence.findOneAndUpdate(
      { sessionId },
      { $set: { isRevoked: true } },
      { new: true }
    );

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // If it's an admin session, also revoke refresh tokens
    if (session.userType === 'ADMIN' && session.userId) {
      await RefreshToken.revokeAllForUser(session.userId, 'admin');
    }

    // Log audit
    await AuditLog.create({
      action: 'SESSION_REVOKE',
      userType: 'admin',
      userId: req.admin._id,
      actorName: req.admin.name || req.admin.email,
      target: `Session ${sessionId} (${session.userType})`,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      path: req.originalUrl,
      method: 'POST',
      status: 200,
      success: true,
      body: { sessionId, userType: session.userType, userLabel: session.userLabel },
      timestamp: new Date(),
    });

    const io = req.app.get('io');
    if (io) {
      io.to('command-center').emit('presence:revoked', { sessionId });
    }

    return res.json({ ok: true, message: 'Session successfully revoked' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * 5. SECURITY CENTER
 */
router.get('/security', authAdmin, async (req, res) => {
  try {
    const [activeRefreshTokens, recentSecurityLogs, adminsList] = await Promise.all([
      RefreshToken.find({ userType: 'admin', expiresAt: { $gt: new Date() } })
        .populate('userId', 'name email')
        .sort({ updatedAt: -1 })
        .lean(),
      AuditLog.find({
        action: {
          $in: [
            'FAILED_LOGIN',
            'FAILED_ADMIN_LOGIN',
            'FAILED_CC_LOGIN',
            'LOGIN',
            'LOGOUT',
            'RESET_LOGIN_ATTEMPTS',
            'RESET_ADMIN_ATTEMPTS',
            'RESET_CC_ATTEMPTS',
            'SESSION_REVOKE',
            'SETTINGS_UPDATE',
            'PASSWORD_CHANGE',
            'MAINTENANCE_MODE_CHANGE',
            'FORCE_LOGOUT_ALL',
            'PASSKEY_DELETE',
            'PASSKEY_TRIGGER',
          ],
        },
      })
        .sort({ timestamp: -1 })
        .limit(25)
        .lean(),
      Admin.find({}).select('name email tokenVersion trustedDevices passkeys createdAt').lean(),
    ]);

    return res.json({
      ok: true,
      adminFailedAttempts: adminFailedLoginTracker.attempts.slice(0, 30),
      adminFailedAttemptsCount: adminFailedLoginTracker.attempts.length,
      adminLastResetAt: adminFailedLoginTracker.lastResetAt,
      ccFailedAttempts: ccFailedLoginTracker.attempts.slice(0, 30),
      ccFailedAttemptsCount: ccFailedLoginTracker.attempts.length,
      ccLastResetAt: ccFailedLoginTracker.lastResetAt,
      failedAttempts: [
        ...adminFailedLoginTracker.attempts.map((a) => ({ ...a, source: 'Admin Web' })),
        ...ccFailedLoginTracker.attempts.map((c) => ({ ...c, source: 'Terminal CC' })),
      ]
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 30),
      failedAttemptsCount: adminFailedLoginTracker.attempts.length + ccFailedLoginTracker.attempts.length,
      activeAdminSessions: activeRefreshTokens,
      admins: adminsList,
      recentSecurityEvents: recentSecurityLogs,
    });
  } catch (error) {
    logger.error('COMMAND_CENTER', `Security center query failed: ${error.message}`, { error });
    return res.status(500).json({ error: 'Failed to fetch security telemetry' });
  }
});

/**
 * Reset Web Admin Login Attempts Action (/admin/login)
 */
router.post('/security/reset-admin-attempts', authAdmin, async (req, res) => {
  try {
    const previousCount = adminFailedLoginTracker.attempts.length;
    adminFailedLoginTracker.attempts = [];
    adminFailedLoginTracker.recentFailures = 0;
    adminFailedLoginTracker.lastResetAt = new Date();

    // Audit log this privileged action
    await AuditLog.create({
      action: 'RESET_ADMIN_ATTEMPTS',
      userType: 'admin',
      userId: req.admin._id,
      actorName: req.admin.name || req.admin.email,
      target: 'Web Admin Portal Lockout Engine',
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      path: req.originalUrl,
      method: 'POST',
      status: 200,
      success: true,
      body: { clearedAttemptsCount: previousCount, resetBy: req.admin.email },
      timestamp: new Date(),
    });

    return res.json({
      ok: true,
      message: `Successfully cleared ${previousCount} Admin web portal failed login attempts.`,
      clearedCount: previousCount,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Reset Command Center Terminal Login Attempts Action
 */
router.post('/security/reset-cc-attempts', authAdmin, async (req, res) => {
  try {
    const previousCount = ccFailedLoginTracker.attempts.length;
    ccFailedLoginTracker.attempts = [];
    ccFailedLoginTracker.recentFailures = 0;
    ccFailedLoginTracker.lastResetAt = new Date();

    // Audit log this privileged action
    await AuditLog.create({
      action: 'RESET_CC_ATTEMPTS',
      userType: 'admin',
      userId: req.admin._id,
      actorName: req.admin.name || req.admin.email,
      target: 'Command Center Terminal Auth Lockout Engine',
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      path: req.originalUrl,
      method: 'POST',
      status: 200,
      success: true,
      body: { clearedAttemptsCount: previousCount, resetBy: req.admin.email },
      timestamp: new Date(),
    });

    return res.json({
      ok: true,
      message: `Successfully cleared ${previousCount} Command Center terminal failed login attempts.`,
      clearedCount: previousCount,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Revoke specific admin token session
 */
router.post('/security/revoke-admin-token', authAdmin, async (req, res) => {
  try {
    const { tokenId } = req.body;
    if (!tokenId) return res.status(400).json({ error: 'tokenId is required' });

    const deleted = await RefreshToken.findByIdAndDelete(tokenId);

    await AuditLog.create({
      action: 'SESSION_REVOKE',
      userType: 'admin',
      userId: req.admin._id,
      actorName: req.admin.name || req.admin.email,
      target: `Admin Refresh Token ${tokenId}`,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      path: req.originalUrl,
      method: 'POST',
      status: 200,
      success: true,
      body: { tokenId, adminTarget: deleted?.userId },
      timestamp: new Date(),
    });

    return res.json({ ok: true, message: 'Admin session token revoked' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * 5.1 LIVE ADMIN USERS & SESSIONS LIST
 * Details on which admins are currently logged into the /admin portal, what page they are on, and device details.
 */
router.get('/admin-sessions', authAdmin, async (req, res) => {
  try {
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [adminSessions, registeredAdmins] = await Promise.all([
      SessionPresence.find({
        userType: 'ADMIN',
        lastSeenAt: { $gte: since },
      })
        .sort({ lastSeenAt: -1 })
        .lean(),
      Admin.find({}).select('name email lastUsed').lean(),
    ]);

    const adminEmailMap = new Map();
    registeredAdmins.forEach((a) => {
      adminEmailMap.set(a._id.toString(), a.email);
    });

    const formattedSessions = adminSessions.map((s) => {
      const diffSeconds = Math.floor((now.getTime() - new Date(s.lastSeenAt).getTime()) / 1000);
      let status = 'offline';
      if (s.isRevoked) {
        status = 'revoked';
      } else if (diffSeconds <= 20) {
        status = 'online';
      } else if (diffSeconds <= 90) {
        status = 'idle';
      }

      return {
        sessionId: s.sessionId,
        userId: s.userId,
        userLabel: s.userLabel || 'Admin Operator',
        adminEmail: s.userId ? adminEmailMap.get(s.userId.toString()) || s.userLabel : s.userLabel,
        deviceModel: s.deviceModel || 'Desktop / PC',
        browser: s.browser || 'Unknown',
        browserVersion: s.browserVersion || '',
        os: s.os || 'Unknown OS',
        osVersion: s.osVersion || '',
        screenResolution: s.screenResolution || 'N/A',
        ip: s.ip || '127.0.0.1',
        currentPage: s.currentPage || '/admin',
        lastSeenAt: s.lastSeenAt,
        lastSeenSecondsAgo: diffSeconds,
        sessionStartTime: s.sessionStartTime,
        status,
        isRevoked: s.isRevoked,
      };
    });

    return res.json({
      ok: true,
      onlineCount: formattedSessions.filter((s) => s.status === 'online').length,
      idleCount: formattedSessions.filter((s) => s.status === 'idle').length,
      totalCount: formattedSessions.length,
      sessions: formattedSessions,
    });
  } catch (error) {
    logger.error('COMMAND_CENTER', `Failed to fetch admin sessions: ${error.message}`, { error });
    return res.status(500).json({ error: 'Failed to fetch admin sessions' });
  }
});

/**
 * 5.2 PASSKEY MANAGER
 * List all admin accounts, their biometric passkeys, and trusted device fingerprints.
 */
router.get('/admin-passkeys', authAdmin, async (req, res) => {
  try {
    const admins = await Admin.find({}).select('name email passkeys trustedDevices createdAt').lean();

    const formatted = admins.map((adm) => ({
      adminId: adm._id,
      name: adm.name,
      email: adm.email,
      passkeys: (adm.passkeys || []).map((p) => ({
        credentialId: p.credentialId,
        label: p.label || 'Biometric Passkey',
        createdAt: p.createdAt,
      })),
      passkeysCount: (adm.passkeys || []).length,
      trustedDevices: (adm.trustedDevices || []).map((d) => ({
        fingerprint: d.fingerprint,
        label: d.label || 'Trusted Device',
        ip: d.ip,
        lastUsed: d.lastUsed,
      })),
      trustedDevicesCount: (adm.trustedDevices || []).length,
    }));

    return res.json({
      ok: true,
      admins: formatted,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a specific passkey from an admin account
 */
router.delete('/admin-passkeys/:adminId/:credentialId', authAdmin, async (req, res) => {
  try {
    const { adminId, credentialId } = req.params;
    const admin = await Admin.findById(adminId);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    const prevCount = (admin.passkeys || []).length;
    admin.passkeys = (admin.passkeys || []).filter((p) => p.credentialId !== credentialId);
    await admin.save();

    await AuditLog.create({
      action: 'PASSKEY_DELETE',
      userType: 'admin',
      userId: req.admin._id,
      actorName: req.admin.name || req.admin.email,
      target: `Passkey ${credentialId} for Admin ${admin.email}`,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      path: req.originalUrl,
      method: 'DELETE',
      status: 200,
      success: true,
      body: { adminId, credentialId, remainingPasskeys: admin.passkeys.length },
      timestamp: new Date(),
    });

    return res.json({
      ok: true,
      message: `Passkey removed successfully from ${admin.email}.`,
      removed: prevCount > admin.passkeys.length,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Trigger passkey prompt / push notification to an admin's device
 */
router.post('/admin-passkeys/:adminId/trigger', authAdmin, async (req, res) => {
  try {
    const { adminId } = req.params;
    const admin = await Admin.findById(adminId);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    // Send push notification
    try {
      await sendAdminPushNotification('🔑 Biometric Passkey Prompt', {
        body: `Passkey login requested for ${admin.email}. Tap to authenticate with your biometric sensor.`,
        data: { url: '/admin/login?passkey_trigger=1' },
        tag: `passkey-prompt-${admin._id}`,
        requireInteraction: true,
      });
    } catch (pushErr) {
      logger.warn('COMMAND_CENTER', `Passkey push notification warning: ${pushErr.message}`);
    }

    // Broadcast socket event to admin socket room
    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('admin:passkey_trigger', {
        adminId: admin._id.toString(),
        adminEmail: admin.email,
        triggeredBy: req.admin.email,
        timestamp: new Date().toISOString(),
      });
    }

    await AuditLog.create({
      action: 'PASSKEY_TRIGGER',
      userType: 'admin',
      userId: req.admin._id,
      actorName: req.admin.name || req.admin.email,
      target: `Passkey prompt triggered for ${admin.email}`,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      path: req.originalUrl,
      method: 'POST',
      status: 200,
      success: true,
      body: { adminId: admin._id, adminEmail: admin.email },
      timestamp: new Date(),
    });

    return res.json({
      ok: true,
      message: `Biometric passkey prompt and push notification successfully sent to ${admin.email}'s devices.`,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Revoke specific admin token session
 */
router.post('/security/revoke-admin-token', authAdmin, async (req, res) => {
  try {
    const { tokenId } = req.body;
    if (!tokenId) return res.status(400).json({ error: 'tokenId is required' });

    const deleted = await RefreshToken.findByIdAndDelete(tokenId);

    await AuditLog.create({
      action: 'SESSION_REVOKE',
      userType: 'admin',
      userId: req.admin._id,
      actorName: req.admin.name || req.admin.email,
      target: `Admin Refresh Token ${tokenId}`,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      path: req.originalUrl,
      method: 'POST',
      status: 200,
      success: true,
      body: { tokenId, adminTarget: deleted?.userId },
      timestamp: new Date(),
    });

    return res.json({ ok: true, message: 'Admin session token revoked' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * 6. SERVER HEALTH & TELEMETRY MATRIX
 */
router.get('/server-health', authAdmin, async (req, res) => {
  try {
    const healthMonitor = getHealthMonitor();
    const status = healthMonitor.getHealthStatus();

    // Check DB ping
    let dbPingMs = 0;
    const dbStart = Date.now();
    try {
      if (mongoose.connection.db) {
        await mongoose.connection.db.admin().ping();
      }
      dbPingMs = Date.now() - dbStart;
    } catch {
      dbPingMs = -1;
    }

    // Sub-service status evaluations
    const services = {
      api: {
        name: 'API Gateway',
        status: status.metrics.api.errorRate > 5 ? 'degraded' : 'operational',
        latencyMs: Math.round(status.metrics.api.avgResponseTime || 12),
        requestCount: status.metrics.api.requestCount,
        errorRate: `${(status.metrics.api.errorRate || 0).toFixed(2)}%`,
      },
      database: {
        name: 'MongoDB Cluster',
        status: mongoose.connection.readyState === 1 ? 'operational' : 'offline',
        latencyMs: dbPingMs,
        readyState: mongoose.connection.readyState,
        nameStr: mongoose.connection.name || 'nerocafe',
      },
      authentication: {
        name: 'JWT & Admin Auth Engine',
        status: process.env.ADMIN_JWT_SECRET ? 'operational' : 'degraded',
        tokenExpiry: '365d',
      },
      orderService: {
        name: 'Order & ETA Engine',
        status: 'operational',
        activeQueues: 1,
      },
      paymentService: {
        name: 'Razorpay Gateway Integration',
        status: process.env.RAZORPAY_KEY_ID ? 'operational' : 'degraded',
        mode: process.env.RAZORPAY_KEY_ID?.startsWith('rzp_live') ? 'LIVE' : 'TEST',
      },
      notificationService: {
        name: 'Socket.IO & Push Services',
        status: status.metrics.socket.connections >= 0 ? 'operational' : 'degraded',
        activeConnections: status.metrics.socket.connections,
      },
    };

    const cpus = os.cpus();
    const memory = {
      totalMB: Math.round(os.totalmem() / (1024 * 1024)),
      freeMB: Math.round(os.freemem() / (1024 * 1024)),
      usedMB: Math.round((os.totalmem() - os.freemem()) / (1024 * 1024)),
      usagePercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
    };

    return res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      overallStatus: status.status,
      services,
      host: {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        cpuCores: cpus.length,
        cpuModel: cpus[0]?.model || 'Standard CPU',
        cpuUsagePercent: Math.round(status.metrics.cpu.usage || 0),
        memory,
        uptimeSeconds: Math.floor(os.uptime()),
        processUptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        appVersion: '1.0.0',
        environment: process.env.NODE_ENV || 'production',
        lastHealthCheck: new Date().toISOString(),
      },
      issues: status.issues,
    });
  } catch (error) {
    logger.error('COMMAND_CENTER', `Server health diagnostics failed: ${error.message}`, { error });
    return res.status(500).json({ error: 'Failed to run server health diagnostics' });
  }
});

/**
 * 7. PROTECTED SYSTEM CONTROLS
 */
router.post('/system/maintenance', authAdmin, async (req, res) => {
  try {
    const { enabled, message } = req.body;
    const settings = await getOrCreateShopSettings();
    settings.maintenanceMode = Boolean(enabled);
    if (message) settings.maintenanceMessage = String(message).trim();
    await settings.save();

    // Log audit
    await AuditLog.create({
      action: 'MAINTENANCE_MODE_CHANGE',
      userType: 'admin',
      userId: req.admin._id,
      actorName: req.admin.name || req.admin.email,
      target: `System Maintenance Mode -> ${settings.maintenanceMode ? 'ENABLED' : 'DISABLED'}`,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      path: req.originalUrl,
      method: 'POST',
      status: 200,
      success: true,
      body: { maintenanceMode: settings.maintenanceMode, message: settings.maintenanceMessage },
      timestamp: new Date(),
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('shop:maintenance_update', {
        maintenanceMode: settings.maintenanceMode,
        message: settings.maintenanceMessage,
      });
    }

    return res.json({
      ok: true,
      message: `Maintenance mode ${settings.maintenanceMode ? 'enabled' : 'disabled'}`,
      settings,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/system/ordering', authAdmin, async (req, res) => {
  try {
    const { enabled, closedMessage } = req.body;
    const settings = await getOrCreateShopSettings();
    settings.shopOpen = Boolean(enabled);
    if (closedMessage) settings.closedMessage = String(closedMessage).trim();
    await settings.save();

    await AuditLog.create({
      action: 'ORDERING_STATUS_CHANGE',
      userType: 'admin',
      userId: req.admin._id,
      actorName: req.admin.name || req.admin.email,
      target: `Cafe Ordering Open Status -> ${settings.shopOpen ? 'OPEN' : 'CLOSED'}`,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      path: req.originalUrl,
      method: 'POST',
      status: 200,
      success: true,
      body: { shopOpen: settings.shopOpen, closedMessage: settings.closedMessage },
      timestamp: new Date(),
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('shop:status_update', {
        shopOpen: settings.shopOpen,
        closedMessage: settings.closedMessage,
      });
    }

    return res.json({
      ok: true,
      message: `Ordering is now ${settings.shopOpen ? 'ENABLED (Cafe Open)' : 'DISABLED (Cafe Closed)'}`,
      settings,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/system/clear-cache', authAdmin, async (req, res) => {
  try {
    const healthMonitor = getHealthMonitor();
    // Reset transient telemetry response times buffer
    healthMonitor.metrics.api.responseTimes = [];
    healthMonitor.metrics.database.queryTimes = [];
    healthMonitor.metrics.api.errorCount = 0;
    healthMonitor.metrics.api.requestCount = 0;

    await AuditLog.create({
      action: 'CACHE_CLEAR',
      userType: 'admin',
      userId: req.admin._id,
      actorName: req.admin.name || req.admin.email,
      target: 'In-Memory API Telemetry & Caching Engine',
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      path: req.originalUrl,
      method: 'POST',
      status: 200,
      success: true,
      body: { cleared: true },
      timestamp: new Date(),
    });

    return res.json({
      ok: true,
      message: 'In-memory metrics buffer and performance cache flushed successfully',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/system/force-logout-all', authAdmin, async (req, res) => {
  try {
    // Invalidate all admin sessions by incrementing tokenVersion
    await Admin.updateMany({}, { $inc: { tokenVersion: 1 } });
    await RefreshToken.deleteMany({});

    await AuditLog.create({
      action: 'FORCE_LOGOUT_ALL',
      userType: 'admin',
      userId: req.admin._id,
      actorName: req.admin.name || req.admin.email,
      target: 'All Active User & Admin Refresh Tokens',
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      path: req.originalUrl,
      method: 'POST',
      status: 200,
      success: true,
      body: { executedBy: req.admin.email },
      timestamp: new Date(),
    });

    return res.json({
      ok: true,
      message: 'All customer and admin sessions invalidated. Re-authentication required.',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * 8. OPERATIONS ANALYTICS
 */
router.get('/analytics', authAdmin, async (req, res) => {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const [
      ordersLast7Days,
      popularItemsAggregate,
      cancellationAggregate,
      hourlyDistribution,
    ] = await Promise.all([
      // Orders daily last 7 days
      Order.aggregate([
        { $match: { createdAt: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
            },
            count: { $sum: 1 },
            revenue: {
              $sum: {
                $cond: [{ $in: ['$paymentStatus', ['Completed', 'Pending', 'Cash Pending']] }, '$totalPrice', 0],
              },
            },
            completedCount: {
              $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] },
            },
            cancelledCount: {
              $sum: { $cond: [{ $eq: ['$status', 'Cancelled'] }, 1, 0] },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      // Top 8 menu items
      Order.aggregate([
        { $match: { createdAt: { $gte: sevenDaysAgo }, status: { $ne: 'Cancelled' } } },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.name',
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
          },
        },
        { $sort: { totalQuantity: -1 } },
        { $limit: 8 },
      ]),
      // Cancellation reasons
      Order.aggregate([
        { $match: { status: 'Cancelled', createdAt: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: { $ifNull: ['$cancellationReason', 'Not specified'] },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
      // Hourly distribution
      Order.aggregate([
        { $match: { createdAt: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: { $hour: '$createdAt' },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    // Calculate aggregate totals
    let totalRevenue7d = 0;
    let totalOrders7d = 0;
    let totalCompleted7d = 0;
    let totalCancelled7d = 0;

    ordersLast7Days.forEach((day) => {
      totalRevenue7d += day.revenue;
      totalOrders7d += day.count;
      totalCompleted7d += day.completedCount;
      totalCancelled7d += day.cancelledCount;
    });

    const aov = totalOrders7d > 0 ? Math.round(totalRevenue7d / totalOrders7d) : 0;
    const completionRate = totalOrders7d > 0 ? ((totalCompleted7d / totalOrders7d) * 100).toFixed(1) : 0;
    const cancellationRate = totalOrders7d > 0 ? ((totalCancelled7d / totalOrders7d) * 100).toFixed(1) : 0;

    // Build 24h curve with proper hour labels
    const hourlyOrders = Array.from({ length: 24 }, (_, h) => {
      const found = hourlyDistribution.find((item) => item._id === h);
      return {
        hour: `${h.toString().padStart(2, '0')}:00`,
        orders: found ? found.count : 0,
      };
    });

    return res.json({
      ok: true,
      summary: {
        totalRevenue7d,
        totalOrders7d,
        averageOrderValue: aov,
        completionRate: `${completionRate}%`,
        cancellationRate: `${cancellationRate}%`,
        averagePrepTimeMinutes: 18,
      },
      dailyTrends: ordersLast7Days.map((d) => ({
        date: d._id,
        orders: d.count,
        revenue: d.revenue,
        completed: d.completedCount,
        cancelled: d.cancelledCount,
      })),
      topItems: popularItemsAggregate.map((item) => ({
        name: item._id,
        quantity: item.totalQuantity,
        revenue: item.totalRevenue,
      })),
      cancellationReasons: cancellationAggregate.map((c) => ({
        reason: c._id || 'Unknown',
        count: c.count,
      })),
      hourlyOrders,
    });
  } catch (error) {
    logger.error('COMMAND_CENTER', `Analytics calculation failed: ${error.message}`, { error });
    return res.status(500).json({ error: 'Failed to generate analytics' });
  }
});

/**
 * 9. IMMUTABLE AUDIT LOG VIEWER
 */
router.get('/audit-logs', authAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 40,
      action,
      userType,
      search,
      startDate,
      endDate,
    } = req.query;

    const query = {};

    if (action && action !== 'ALL') {
      query.action = action;
    }

    if (userType && userType !== 'ALL') {
      query.userType = userType;
    }

    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = new Date(startDate);
      if (endDate) query.timestamp.$lte = new Date(endDate);
    }

    if (search && search.trim()) {
      const regex = { $regex: search.trim(), $options: 'i' };
      query.$or = [
        { action: regex },
        { actorName: regex },
        { target: regex },
        { ip: regex },
        { path: regex },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [logs, total] = await Promise.all([
      AuditLog.find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      AuditLog.countDocuments(query),
    ]);

    return res.json({
      ok: true,
      logs,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    logger.error('COMMAND_CENTER', `Audit logs fetch failed: ${error.message}`, { error });
    return res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

/**
 * 10. NOTIFICATIONS & ACTIVE ALERTS
 */
router.get('/notifications', authAdmin, async (req, res) => {
  try {
    const healthMonitor = getHealthMonitor();
    const health = healthMonitor.getHealthStatus();

    const alerts = [];

    if (health.status === 'critical') {
      alerts.push({
        id: 'crit-server',
        level: 'CRITICAL',
        title: 'Server Resource Exhaustion Alert',
        message: health.issues.join(', ') || 'High CPU/Memory usage detected on server host',
        timestamp: new Date().toISOString(),
      });
    }

    if (failedLoginTracker.recentFailures > 5) {
      alerts.push({
        id: 'warn-failed-logins',
        level: 'WARNING',
        title: 'Elevated Failed Login Attempts',
        message: `${failedLoginTracker.recentFailures} failed admin authentication attempts detected.`,
        timestamp: new Date().toISOString(),
      });
    }

    // Check for orders stuck in received > 45 mins
    const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000);
    const stuckOrdersCount = await Order.countDocuments({
      status: 'Received',
      createdAt: { $lte: fortyFiveMinsAgo },
    });

    if (stuckOrdersCount > 0) {
      alerts.push({
        id: 'warn-stuck-orders',
        level: 'WARNING',
        title: 'Pending Orders Queue Alert',
        message: `${stuckOrdersCount} order(s) received over 45 minutes ago are still awaiting confirmation.`,
        timestamp: new Date().toISOString(),
      });
    }

    return res.json({
      ok: true,
      alerts,
      activeCount: alerts.length,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
