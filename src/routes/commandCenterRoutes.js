import { Router } from 'express';
import os from 'os';
import fs from 'fs';
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
import { BlockedDevice } from '../models/BlockedDevice.js';
import { authAdmin } from '../middleware/authAdmin.js';
import { getHealthMonitor } from '../utils/healthMonitor.js';
import { logger } from '../utils/logger.js';
import { sendAdminPushNotification, sendUserPushNotification } from '../utils/pushNotifications.js';
import { Branch } from '../models/Branch.js';
import { branchDbManager } from '../config/branchDbManager.js';
import { passkeyEnrollmentManager } from '../utils/passkeyEnrollmentManager.js';

const router = Router();

export async function getStorageStats() {
  let dbStorage = {
    dataSizeMB: '0.00',
    storageSizeMB: '0.00',
    indexSizeMB: '0.00',
    totalAllocatedMB: '0.00',
    documentCount: 0,
    collectionsCount: 0,
  };
  let hostDisk = {
    totalDiskGB: '0.0',
    freeDiskGB: '0.0',
    usedDiskGB: '0.0',
    usedDiskPercent: 0,
  };

  try {
    if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
      const s = await mongoose.connection.db.stats();
      dbStorage = {
        dataSizeMB: ((s.dataSize || 0) / (1024 * 1024)).toFixed(2),
        storageSizeMB: ((s.storageSize || 0) / (1024 * 1024)).toFixed(2),
        indexSizeMB: ((s.indexSize || 0) / (1024 * 1024)).toFixed(2),
        totalAllocatedMB: (((s.storageSize || 0) + (s.indexSize || 0)) / (1024 * 1024)).toFixed(2),
        documentCount: s.objects || 0,
        collectionsCount: s.collections || 0,
      };
    }
  } catch (err) {
    logger.warn('COMMAND_CENTER', `Failed to get db stats: ${err.message}`);
  }

  try {
    if (fs.promises?.statfs) {
      const stat = await fs.promises.statfs(process.cwd());
      const totalGB = (stat.blocks * stat.bsize) / (1024 * 1024 * 1024);
      const freeGB = (stat.bavail * stat.bsize) / (1024 * 1024 * 1024);
      const usedGB = Math.max(0, totalGB - freeGB);
      const percent = totalGB > 0 ? Math.round((usedGB / totalGB) * 100) : 0;
      hostDisk = {
        totalDiskGB: totalGB.toFixed(1),
        freeDiskGB: freeGB.toFixed(1),
        usedDiskGB: usedGB.toFixed(1),
        usedDiskPercent: percent,
      };
    }
  } catch (err) {
    logger.warn('COMMAND_CENTER', `Failed to get host disk stats: ${err.message}`);
  }

  return { dbStorage, hostDisk };
}

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

    const selectedBranch = req.query.branchId || req.headers['x-branch-id'] || 'ALL';
    const allBranches = await branchDbManager.getActiveBranches();

    const now = new Date();
    // India Standard Time (UTC+5:30) midnight start
    const istOffsetMs = 330 * 60 * 1000;
    const istDate = new Date(now.getTime() + istOffsetMs);
    istDate.setUTCHours(0, 0, 0, 0);
    const startOfTodayIST = new Date(istDate.getTime() - istOffsetMs);

    // Look at past 24 hours to ensure recent orders within 24h are never dropped
    const past24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const effectiveStartDate = startOfTodayIST < past24Hours ? startOfTodayIST : past24Hours;

    const oneMinAgo = new Date(now.getTime() - 60 * 1000);

    const branchOrderMatch = selectedBranch !== 'ALL' ? { branchId: selectedBranch } : {};
    const branchPresenceMatch = selectedBranch !== 'ALL' ? { branchId: selectedBranch } : {};

    // Run parallel database queries for speed and efficiency
    const [
      ordersToday,
      activeOrdersInProgress,
      activeSessionsCustomer,
      activeSessionsAdmin,
      totalSessions,
      recentUsers,
      activeTokensCount,
      shopSettings,
      blockedDevicesCount,
      branchCards,
    ] = await Promise.all([
      // Orders today aggregated
      Order.aggregate([
        { $match: { createdAt: { $gte: effectiveStartDate }, cancelledAt: null, ...branchOrderMatch } },
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
      // In addition, all active in-progress orders (regardless of timestamp)
      Order.find({
        status: { $in: ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing', 'Ready'] },
        cancelledAt: null,
        ...branchOrderMatch,
      }).lean(),
      // Active sessions count (last seen < 60s)
      SessionPresence.countDocuments({
        userType: 'CUSTOMER',
        lastSeenAt: { $gte: oneMinAgo },
        isRevoked: false,
        ...branchPresenceMatch,
      }),
      SessionPresence.countDocuments({
        userType: 'ADMIN',
        lastSeenAt: { $gte: oneMinAgo },
        isRevoked: false,
        ...branchPresenceMatch,
      }),
      SessionPresence.countDocuments({
        lastSeenAt: { $gte: oneMinAgo },
        isRevoked: false,
        ...branchPresenceMatch,
      }),
      // Recent active users
      User.find({}).sort({ updatedAt: -1 }).limit(5).select('name email phone updatedAt createdAt').lean(),
      // Active admin refresh tokens
      RefreshToken.countDocuments({ userType: 'admin', expiresAt: { $gt: now } }),
      // Settings
      getOrCreateShopSettings(),
      // Blocked devices
      BlockedDevice.countDocuments({ isActive: true }),
      // Per-branch telemetry cards
      Promise.all(
        allBranches.map(async (b) => {
          const [activeOrdersCount, customerCount, adminCount] = await Promise.all([
            Order.countDocuments({
              branchId: b.branchId,
              status: { $in: ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing', 'Ready'] },
              cancelledAt: null,
            }),
            SessionPresence.countDocuments({
              branchId: b.branchId,
              userType: 'CUSTOMER',
              lastSeenAt: { $gte: oneMinAgo },
              isRevoked: false,
            }),
            SessionPresence.countDocuments({
              branchId: b.branchId,
              userType: 'ADMIN',
              lastSeenAt: { $gte: oneMinAgo },
              isRevoked: false,
            }),
          ]);
          return {
            branchId: b.branchId,
            branchCode: b.branchCode,
            name: b.name,
            displayName: b.displayName || b.name,
            status: b.status === 'ACTIVE' ? 'ONLINE' : 'OFFLINE',
            activeOrders: activeOrdersCount,
            customerDevices: customerCount,
            adminDevices: adminCount,
            totalDevices: customerCount + adminCount,
          };
        })
      ),
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

    const activeStatusCounts = {
      received: 0,
      confirmed: 0,
      preparing: 0,
      ready: 0,
    };

    activeOrdersInProgress.forEach((ord) => {
      const st = String(ord.status || '').toLowerCase();
      if (st === 'received') activeStatusCounts.received++;
      else if (st === 'confirmed') activeStatusCounts.confirmed++;
      else if (st === 'preparing' || st === 'cooking' || st === 'queued' || st === 'packing') activeStatusCounts.preparing++;
      else if (st === 'ready') activeStatusCounts.ready++;
    });

    ordersToday.forEach((group) => {
      const count = group.count || 0;
      orderStats.totalToday += count;
      orderStats.totalRevenueToday += group.revenue || 0;

      const st = String(group._id).toLowerCase();
      if (st === 'received') {
        orderStats.received += count;
      } else if (st === 'confirmed') {
        orderStats.confirmed += count;
      } else if (st === 'preparing' || st === 'cooking' || st === 'queued' || st === 'packing') {
        orderStats.preparing += count;
      } else if (st === 'ready') {
        orderStats.ready += count;
      } else if (st === 'completed') {
        orderStats.completed += count;
      } else if (st === 'cancelled') {
        orderStats.cancelled += count;
      }
    });

    // Ensure all active in-progress orders are fully counted in pipeline
    orderStats.received = Math.max(orderStats.received, activeStatusCounts.received);
    orderStats.confirmed = Math.max(orderStats.confirmed, activeStatusCounts.confirmed);
    orderStats.preparing = Math.max(orderStats.preparing, activeStatusCounts.preparing);
    orderStats.ready = Math.max(orderStats.ready, activeStatusCounts.ready);
    orderStats.active = activeOrdersInProgress.length;
    orderStats.totalToday = Math.max(orderStats.totalToday, activeOrdersInProgress.length + orderStats.completed);

    const recentSecurityEvents = await AuditLog.find({
      action: { $in: ['FAILED_LOGIN', 'LOGIN', 'LOGOUT', 'RESET_LOGIN_ATTEMPTS', 'SESSION_REVOKE', 'SETTINGS_UPDATE'] },
    })
      .sort({ timestamp: -1 })
      .limit(6)
      .lean();

    const { dbStorage, hostDisk } = await getStorageStats();

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
        dbStorage,
        hostDisk,
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
      branches: {
        activeBranch: selectedBranch,
        availableBranches: allBranches.map((b) => ({
          branchId: b.branchId,
          branchCode: b.branchCode,
          name: b.name,
          displayName: b.displayName || b.name,
        })),
        branchCards,
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
      branchId,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    const query = {};

    const targetBranch = branchId || req.headers['x-branch-id'];
    if (targetBranch && targetBranch !== 'ALL') {
      query.branchId = targetBranch;
    }

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
    const branchId = req.query.branchId || req.headers['x-branch-id'];

    const sessionQuery = {
      lastSeenAt: { $gte: since },
    };
    if (branchId && branchId !== 'ALL') {
      sessionQuery.branchId = branchId;
    }

    const [sessions, blockedList] = await Promise.all([
      SessionPresence.find(sessionQuery)
        .sort({ lastSeenAt: -1 })
        .limit(100)
        .lean(),
      BlockedDevice.find({ isActive: true }).lean(),
    ]);

    const blockedSet = new Set();
    blockedList.forEach((b) => {
      if (b.target && b.target !== '127.0.0.1' && b.target !== '::1') blockedSet.add(b.target);
      if (b.phone) blockedSet.add(b.phone);
      if (b.fingerprint) blockedSet.add(b.fingerprint);
    });

    const formattedSessions = sessions.map((s) => {
      const diffSeconds = Math.floor((now.getTime() - new Date(s.lastSeenAt).getTime()) / 1000);
      
      // Admin terminals & operators are strictly NEVER marked as blocked
      const isBlocked =
        s.userType !== 'ADMIN' &&
        (blockedSet.has(s.sessionId) ||
          (s.metadata?.phone && blockedSet.has(s.metadata.phone)) ||
          (s.phone && blockedSet.has(s.phone)));

      let status = 'offline';
      if (isBlocked) {
        status = 'blocked';
      } else if (s.isRevoked) {
        status = 'revoked';
      } else if (diffSeconds <= 20) {
        status = 'online';
      } else if (diffSeconds <= 90) {
        status = 'idle';
      }

      return {
        ...s,
        status,
        isBlocked,
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
        totalBlocked: formattedSessions.filter((s) => s.isBlocked).length,
        customerCount: customerDevices.length,
        adminCount: adminDevices.length,
      },
      customerDevices,
      adminDevices,
      blockedList,
    });
  } catch (error) {
    logger.error('COMMAND_CENTER', `Live devices query failed: ${error.message}`, { error });
    return res.status(500).json({ error: 'Failed to fetch device presence' });
  }
});

/**
 * Block a Device / IP from logging in or connecting
 */
router.post('/blocked-devices/block', authAdmin, async (req, res) => {
  try {
    const { target, type = 'IP', ip, phone, fingerprint, label = 'Blocked Device', reason = 'Blocked by administrator', deviceModel, browser, os } = req.body;
    const finalTarget = (target || phone || ip || fingerprint || '').trim();

    if (!finalTarget) {
      return res.status(400).json({ error: 'Target IP, phone number, device fingerprint, or identifier required to block' });
    }

    if (finalTarget === '127.0.0.1' || finalTarget === '::1' || finalTarget === 'localhost' || finalTarget.includes('127.0.0.1')) {
      return res.status(400).json({ error: 'Cannot block loopback/localhost address (127.0.0.1)' });
    }

    const defaultReason = 'Your IP has been blocked by Operator for more info call 9100020345';
    const cleanPhone = phone ? String(phone).replace(/\D/g, '') : (type === 'PHONE' ? String(finalTarget).replace(/\D/g, '') : '');
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(finalTarget) || (finalTarget.includes(':') && !finalTarget.startsWith('sid_'));
    const resolvedType = type && type !== 'IP' ? type : (cleanPhone ? 'PHONE' : (finalTarget.startsWith('sid_') ? 'SESSION' : (isIp ? 'IP' : 'SESSION')));

    const blockedDoc = await BlockedDevice.findOneAndUpdate(
      { target: finalTarget },
      {
        $set: {
          target: finalTarget,
          type: resolvedType,
          label: label || 'Blocked Device',
          ip: resolvedType === 'IP' ? (ip || finalTarget) : '',
          phone: cleanPhone,
          fingerprint: fingerprint || (resolvedType === 'FINGERPRINT' ? finalTarget : ''),
          deviceModel: deviceModel || 'Unknown Device',
          browser: browser || '',
          os: os || '',
          reason: reason || defaultReason,
          blockedBy: req.admin.email || 'Admin Terminal',
          isActive: true,
          blockedAt: new Date(),
          unblockedAt: null,
        },
      },
      { upsert: true, new: true }
    );

    // Force revoke only the specific session, phone, or target
    const revokeOr = [{ sessionId: finalTarget }, { target: finalTarget }];
    if (resolvedType === 'IP' && !finalTarget.includes('127.0.0.1')) revokeOr.push({ ip: finalTarget });
    if (cleanPhone) revokeOr.push({ 'metadata.phone': cleanPhone });

    await SessionPresence.updateMany(
      { $or: revokeOr },
      { $set: { isRevoked: true } }
    );

    // Audit log
    await AuditLog.create({
      action: 'DEVICE_BLOCK',
      userType: 'admin',
      userId: req.admin._id,
      actorName: req.admin.name || req.admin.email,
      target: `Blocked: ${finalTarget} (${label})`,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      path: req.originalUrl,
      method: 'POST',
      status: 200,
      success: true,
      body: { target: finalTarget, type: resolvedType, phone: cleanPhone, label, reason: blockedDoc.reason, blockedBy: req.admin.email },
      timestamp: new Date(),
    });

    const io = req.app.get('io');
    if (io) {
      const blockPayload = {
        blocked: true,
        target: finalTarget,
        type: blockedDoc.type,
        ip: blockedDoc.ip,
        phone: cleanPhone,
        fingerprint: blockedDoc.fingerprint || '',
        sessionId: (finalTarget.startsWith('sid_') ? finalTarget : ''),
        reason: blockedDoc.reason || defaultReason,
        message: blockedDoc.reason || defaultReason,
        timestamp: new Date().toISOString(),
      };

      // Target specific socket rooms for targeted lockout (DO NOT broadcast globally to avoid locking out other devices/admin panels)
      if (cleanPhone) {
        io.to(`phone:${cleanPhone}`).emit('device:blocked', blockPayload);
        if (cleanPhone.length === 10) io.to(`phone:91${cleanPhone}`).emit('device:blocked', blockPayload);
      }
      if (finalTarget.startsWith('sid_')) {
        io.to(`session:${finalTarget}`).emit('device:blocked', blockPayload);
      }
      if (blockedDoc.fingerprint) {
        io.to(`fp:${blockedDoc.fingerprint}`).emit('device:blocked', blockPayload);
      }
      // Also notify command center room for live monitoring
      io.to('command-center').emit('device:blocked', blockPayload);
    }

    return res.json({
      ok: true,
      message: `Device/IP ${finalTarget} (${label}) has been permanently blocked from logging in.`,
      blockedDevice: blockedDoc,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Unblock a Device / IP
 */
router.post('/blocked-devices/unblock', authAdmin, async (req, res) => {
  try {
    const { target, id } = req.body;
    const query = id ? { _id: id } : { target: (target || '').trim() };

    const unblockedDoc = await BlockedDevice.findOneAndUpdate(
      query,
      {
        $set: {
          isActive: false,
          unblockedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!unblockedDoc) {
      return res.status(404).json({ error: 'Blocked device entry not found' });
    }

    // Restore isRevoked: false on matching session presences
    try {
      const unblockOr = [{ sessionId: unblockedDoc.target }, { target: unblockedDoc.target }];
      if (unblockedDoc.target && (unblockedDoc.target.includes('.') || unblockedDoc.target.includes(':'))) {
        unblockOr.push({ ip: unblockedDoc.target });
      }
      if (unblockedDoc.phone) unblockOr.push({ 'metadata.phone': unblockedDoc.phone });
      if (unblockedDoc.fingerprint) unblockOr.push({ 'metadata.fingerprint': unblockedDoc.fingerprint });

      await SessionPresence.updateMany(
        { $or: unblockOr },
        { $set: { isRevoked: false } }
      );
    } catch (e) {
      logger.warn('COMMAND_CENTER', `Failed to restore session presences on unblock: ${e.message}`);
    }

    await AuditLog.create({
      action: 'DEVICE_UNBLOCK',
      userType: 'admin',
      userId: req.admin._id,
      actorName: req.admin.name || req.admin.email,
      target: `Unblocked Device: ${unblockedDoc.target} (${unblockedDoc.label})`,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      path: req.originalUrl,
      method: 'POST',
      status: 200,
      success: true,
      body: { target: unblockedDoc.target, unblockedBy: req.admin.email },
      timestamp: new Date(),
    });

    const io = req.app.get('io');
    if (io) {
      const unblockPayload = {
        unblocked: true,
        target: unblockedDoc.target,
        phone: unblockedDoc.phone || '',
        fingerprint: unblockedDoc.fingerprint || '',
      };
      io.to('command-center').emit('device:unblocked', unblockPayload);
      io.emit('device:unblocked', unblockPayload);
    }

    return res.json({
      ok: true,
      message: `Device/IP ${unblockedDoc.target} has been successfully unblocked. Access restored.`,
      unblockedDevice: unblockedDoc,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * List all Blocked Devices
 */
router.get('/blocked-devices', authAdmin, async (req, res) => {
  try {
    const blockedDevices = await BlockedDevice.find({}).sort({ updatedAt: -1 }).lean();
    return res.json({
      ok: true,
      activeCount: blockedDevices.filter((d) => d.isActive).length,
      totalCount: blockedDevices.length,
      devices: blockedDevices,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
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
    const [activeRefreshTokens, recentSecurityLogs, adminsList, activeBlockedDevices] = await Promise.all([
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
            'DEVICE_BLOCK',
            'DEVICE_UNBLOCK',
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
      BlockedDevice.find({ isActive: true }).sort({ blockedAt: -1 }).lean(),
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
      blockedDevices: activeBlockedDevices,
      blockedDevicesCount: activeBlockedDevices.length,
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
        city: s.city || '',
        country: s.country || '',
        locationLabel: s.locationLabel || (s.city ? `${s.city}, ${s.country}` : 'Hyderabad / India (Local)'),
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

    // Operator pre-approves passkey registration window for this admin
    const preApproved = passkeyEnrollmentManager.createOperatorApprovedWindow({
      adminId: admin._id.toString(),
      email: admin.email,
      name: admin.name,
      label: 'Operator Authorized Passkey',
    });

    // Send push notification
    try {
      await sendAdminPushNotification('🔑 Biometric Passkey Prompt', {
        body: `Passkey enrollment authorized for ${admin.email}. Tap to authenticate with your biometric sensor.`,
        data: { url: '/admin?passkey_trigger=1' },
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
        enrollmentToken: preApproved.enrollmentToken,
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
      body: { adminId: admin._id, adminEmail: admin.email, enrollmentToken: preApproved.enrollmentToken },
      timestamp: new Date(),
    });

    return res.json({
      ok: true,
      message: `Passkey enrollment prompt pushed and pre-authorized for ${admin.email}.`,
      enrollmentToken: preApproved.enrollmentToken,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * List pending passkey enrollment requests waiting for Command Center approval
 */
router.get('/admin-passkeys/pending-requests', authAdmin, async (req, res) => {
  try {
    const pending = passkeyEnrollmentManager.getPendingRequests();
    return res.json({ ok: true, requests: pending });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Accept / approve a pending passkey enrollment request from the Command Center
 */
router.post('/admin-passkeys/accept-request', authAdmin, async (req, res) => {
  try {
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: 'Request ID is required' });

    const result = passkeyEnrollmentManager.approveRequest(requestId, req.admin.email || 'Terminal Command Center');
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('passkey:request_accepted', {
        requestId,
        adminId: result.request.adminId,
        email: result.request.email,
        enrollmentToken: result.enrollmentToken,
        message: 'Passkey enrollment authorization accepted by Terminal Command Center.',
      });
    }

    await AuditLog.create({
      action: 'PASSKEY_REQUEST_ACCEPTED',
      userType: 'admin',
      userId: req.admin._id,
      actorName: req.admin.name || req.admin.email,
      target: `Passkey request ${requestId} for ${result.request.email}`,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      path: req.originalUrl,
      method: 'POST',
      status: 200,
      success: true,
      body: { requestId, email: result.request.email },
      timestamp: new Date(),
    });

    return res.json({
      ok: true,
      message: `Passkey request for ${result.request.email} ACCEPTED successfully!`,
      request: result.request,
      enrollmentToken: result.enrollmentToken,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Reject a pending passkey enrollment request from the Command Center
 */
router.post('/admin-passkeys/reject-request', authAdmin, async (req, res) => {
  try {
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: 'Request ID is required' });

    const result = passkeyEnrollmentManager.rejectRequest(requestId, req.admin.email || 'Terminal Command Center');
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('passkey:request_rejected', {
        requestId,
        adminId: result.request.adminId,
        email: result.request.email,
        message: 'Passkey enrollment request was rejected by Terminal Command Center.',
      });
    }

    return res.json({
      ok: true,
      message: `Passkey request for ${result.request.email} REJECTED.`,
      request: result.request,
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
