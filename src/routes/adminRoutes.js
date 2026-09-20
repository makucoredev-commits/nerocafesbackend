import { Router } from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Admin } from '../models/Admin.js';
import { Branch } from '../models/Branch.js';
import { branchDbManager } from '../config/branchDbManager.js';
import { Order } from '../models/Order.js';
import { MenuItem } from '../models/MenuItem.js';
import { Customer } from '../models/Customer.js';
import { OfferBanner } from '../models/OfferBanner.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { getOrCreateShopSettings } from '../models/ShopSettings.js';
import { authAdmin } from '../middleware/authAdmin.js';
import { adminAuthLimiter } from '../middleware/rateLimiter.js';
import { sendSMS, makeCall } from '../utils/smsPlaceholder.js';
import { sendPaymentSuccessMessage, sendOrderReadyMessage, sendCancellationMessage } from '../utils/whatsapp.js';
import { sendInvoiceEmail, sendWelcomeEmail, sendOrderStatusEmail } from '../utils/emailPlaceholder.js';
import { createOrderFromBody } from '../utils/orderHelpers.js';
import { User } from '../models/User.js';
import { normalizePhone, validatePhone, getCountryFromCoords } from '../utils/phone.js';
import { sendUserPushNotification } from '../utils/pushNotifications.js';
import { AuditLog } from '../models/AuditLog.js';
import { BlockedDevice } from '../models/BlockedDevice.js';
import { logger } from '../utils/logger.js';
import { syncAllUsersToCustomers } from '../utils/customerSync.js';
import { recordFailedAdminLogin } from './commandCenterRoutes.js';
import { resolveBranchContext, requireBranchAccess } from '../middleware/branchContext.js';
import { passkeyEnrollmentManager } from '../utils/passkeyEnrollmentManager.js';

const router = Router();
const CUSTOMER_VIBRATION_COOLDOWN_MS = 10_000;
const customerVibrationCooldown = new Map();

const ADMIN_ACCESS_EXPIRY = '365d';

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
router.post('/login', adminAuthLimiter, async (req, res) => {
  try {
    const { email, password, fingerprint: clientFingerprint } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.ip || '';
    const ua = req.headers['user-agent'] || '';
    const fp = clientFingerprint || computeFingerprint(ip, ua);

    if (!email) return res.status(400).json({ error: 'Email required' });

    const normalizedEmail = email.toLowerCase().trim();
    const isMasterAdmin = normalizedEmail === 'nerocafes14@gmail.com';

    // Check if specific fingerprint is blocked (never block master admin or by shared IP)
    if (!isMasterAdmin) {
      const isBlocked = await BlockedDevice.findOne({
        isActive: true,
        $or: [{ fingerprint: fp }, { target: fp }],
      });
      if (isBlocked) {
        return res.status(403).json({ error: 'Access Denied: This device has been blocked by administrator.' });
      }
    }

    const admin = await Admin.findOne({ email: email.toLowerCase().trim() });
    if (!admin) {
      recordFailedAdminLogin(email, ip, 'Admin account not found');
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }

    /* Check if this device is trusted (auto-login) */
    const trustedIdx = (admin.trustedDevices || []).findIndex(d => d.fingerprint === fp);
    const isTrusted = trustedIdx >= 0;

    if (!isTrusted) {
      /* New device → require password */
      if (!password) return res.status(400).json({ error: 'Password required for new device' });
      if (!(await admin.comparePassword(password))) {
        recordFailedAdminLogin(email, ip, 'Incorrect password');
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
router.post('/check-device', async (req, res) => {
  try {
    const { email, fingerprint: clientFingerprint } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.ip || '';
    const ua = req.headers['user-agent'] || '';
    const fp = clientFingerprint || computeFingerprint(ip, ua);

    const normalizedEmail = (email || '').toLowerCase().trim();
    const isMasterAdmin = normalizedEmail === 'nerocafes14@gmail.com';

    if (!isMasterAdmin) {
      const isBlocked = await BlockedDevice.findOne({
        isActive: true,
        $or: [{ fingerprint: fp }, { target: fp }],
      });
      if (isBlocked) {
        return res.status(403).json({ trusted: false, blocked: true, error: 'Device is blocked' });
      }
    }

    if (!email) return res.status(400).json({ trusted: false });

    const admin = await Admin.findOne({ email: email.toLowerCase().trim() });
    if (!admin) return res.status(200).json({ trusted: false });

    const trusted = (admin.trustedDevices || []).some(d => d.fingerprint === fp);
    res.json({ trusted });
  } catch {
    res.json({ trusted: false });
  }
});

/* ── Passkey / Biometric Login ───────────────────────────────── */
router.post('/passkey/login', adminAuthLimiter, async (req, res) => {
  try {
    const { email, credentialId } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.ip || '';
    const ua = req.headers['user-agent'] || '';
    const fp = computeFingerprint(ip, ua);

    const normalizedEmail = (email || '').toLowerCase().trim();
    const isMasterAdmin = normalizedEmail === 'nerocafes14@gmail.com';

    if (!isMasterAdmin) {
      const isBlocked = await BlockedDevice.findOne({
        isActive: true,
        $or: [{ fingerprint: fp }, { target: fp }],
      });
      if (isBlocked) {
        return res.status(403).json({ error: 'Access Denied: This device has been blocked by administrator.' });
      }
    }
    
    let admin = null;
    if (email) {
      admin = await Admin.findOne({ email: email.toLowerCase().trim() });
    }
    
    if (!admin && credentialId) {
      admin = await Admin.findOne({ 'passkeys.credentialId': credentialId });
    }

    if (!admin) {
      const count = await Admin.countDocuments();
      if (count === 1) {
        admin = await Admin.findOne();
      }
    }

    if (!admin) {
      return res.status(401).json({ error: 'No admin account found for this passkey' });
    }

    if (credentialId) {
      const exists = (admin.passkeys || []).some(p => p.credentialId === credentialId);
      if (!exists) {
        if (!admin.passkeys) admin.passkeys = [];
        admin.passkeys.push({
          credentialId,
          label: 'Biometric Passkey',
          createdAt: new Date(),
        });
        await admin.save();
      }
    }

    if (!admin.trustedDevices) admin.trustedDevices = [];
    if (!admin.trustedDevices.some(d => d.fingerprint === fp)) {
      admin.trustedDevices.push({ fingerprint: fp, label: 'Passkey / Biometric Device', lastUsed: new Date(), ip: String(ip).slice(0, 45) });
      await admin.save();
    }

    const deviceInfo = ua;
    const { accessToken, refreshToken } = await issueAdminTokenPair(admin, deviceInfo);
    logger.success('ADMIN', `Passkey/Biometric login successful for ${admin.email}`);

    res.json({
      admin: admin.toJSON(),
      token: accessToken,
      refreshToken,
      passkeyLogin: true,
    });
  } catch (e) {
    logger.error('ADMIN', 'Passkey login error:', { error: e });
    res.status(500).json({ error: 'Passkey authentication failed' });
  }
});

/* ── Passkey / Biometric Enrollment Request (Initiated by Website Admin) ── */
router.post('/passkey/request-enrollment', authAdmin, async (req, res) => {
  try {
    const { label } = req.body;
    const admin = await Admin.findById(req.admin._id);
    if (!admin) return res.status(404).json({ error: 'Admin account not found' });

    // Check if operator already pre-approved this admin recently
    const existingApproved = passkeyEnrollmentManager.getApprovedTokenForAdmin(admin._id);
    if (existingApproved) {
      return res.json({
        ok: true,
        alreadyApproved: true,
        requestId: existingApproved.requestId,
        enrollmentToken: existingApproved.enrollmentToken,
        status: 'APPROVED',
        message: 'Passkey enrollment is already pre-approved by Terminal Command Center!',
      });
    }

    const request = passkeyEnrollmentManager.createRequest({
      adminId: admin._id,
      email: admin.email,
      name: admin.name,
      label: label || 'Windows Hello / PC Passkey',
    });

    const io = req.app.get('io');
    if (io) {
      io.to('command-center').emit('command_center:passkey_request', request);
    }

    res.json({
      ok: true,
      requestId: request.requestId,
      status: request.status,
      message: 'Passkey enrollment request queued. Awaiting Terminal Command Center authorization in NCC.',
      request,
    });
  } catch (e) {
    logger.error('ADMIN', 'Passkey request enrollment error:', { error: e });
    res.status(500).json({ error: e.message });
  }
});

/* ── Passkey / Biometric Request Status Polling ───────────────── */
router.get('/passkey/request-status/:requestId', authAdmin, async (req, res) => {
  try {
    const { requestId } = req.params;
    const request = passkeyEnrollmentManager.getRequest(requestId);
    if (!request) {
      return res.status(404).json({ error: 'Request not found or expired' });
    }
    if (String(request.adminId) !== String(req.admin._id)) {
      return res.status(403).json({ error: 'Unauthorized request inquiry' });
    }

    res.json({
      ok: true,
      requestId: request.requestId,
      status: request.status,
      enrollmentToken: request.status === 'APPROVED' ? request.enrollmentToken : null,
      approvedBy: request.approvedBy || null,
      approvedAt: request.approvedAt || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Passkey / Biometric Registration (Authenticated & CMD Approved) ── */
router.post('/passkey/register', authAdmin, async (req, res) => {
  try {
    const { credentialId, label, enrollmentToken } = req.body;
    if (!credentialId) {
      return res.status(400).json({ error: 'Credential ID is required' });
    }

    // MANDATORY SECURITY CHECK: Verify Terminal Command Center Authorization Token
    const isApproved = passkeyEnrollmentManager.verifyAndConsume(req.admin._id, enrollmentToken);
    if (!isApproved) {
      logger.warn('SECURITY', `Passkey registration rejected for ${req.admin.email}: Missing or invalid Command Center enrollment authorization`);
      return res.status(403).json({
        error: 'Passkey enrollment rejected: Terminal Command Center authorization required. Please ask the NCC operator to accept your passkey request.',
        code: 'CMD_AUTH_REQUIRED',
      });
    }

    const admin = await Admin.findById(req.admin._id);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    // Check if this passkey is already registered
    const exists = (admin.passkeys || []).some(p => p.credentialId === credentialId);
    if (exists) {
      return res.json({ ok: true, message: 'Passkey already registered', passkeys: admin.passkeys });
    }

    if (!admin.passkeys) admin.passkeys = [];
    admin.passkeys.push({
      credentialId,
      label: label || 'Biometric Passkey',
      createdAt: new Date(),
    });
    await admin.save();

    logger.success('ADMIN', `Passkey registered for ${admin.email}: ${label || 'Biometric Passkey'} (CMD Authorized)`);
    res.json({ ok: true, message: 'Passkey registered successfully with Command Center authorization', passkeys: admin.passkeys });
  } catch (e) {
    logger.error('ADMIN', 'Passkey register error:', { error: e });
    res.status(500).json({ error: 'Failed to register passkey' });
  }
});

/* ── List admin passkeys ─────────────────────────────────────── */
router.get('/passkeys', authAdmin, async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin._id);
    res.json({ passkeys: admin?.passkeys || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Remove a passkey ────────────────────────────────────────── */
router.delete('/passkey/:credentialId', authAdmin, async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin._id);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    admin.passkeys = (admin.passkeys || []).filter(p => p.credentialId !== req.params.credentialId);
    await admin.save();
    logger.info('ADMIN', `Passkey removed for ${admin.email}`);
    res.json({ ok: true, passkeys: admin.passkeys });
  } catch (e) {
    res.status(500).json({ error: e.message });
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


router.get('/stats', authAdmin, resolveBranchContext, requireBranchAccess, async (req, res) => {
  try {
    const { from, to, allBranches } = req.query;

    const filterDate = {};
    if (from || to) {
      filterDate.createdAt = {};
      if (from) filterDate.createdAt.$gte = new Date(from);
      if (to) filterDate.createdAt.$lte = new Date(to);
    }

    const isSuper = req.admin?.role === 'SUPER_ADMIN';
    const branchScope = isSuper && allBranches === 'true' ? {} : { branchId: req.branchId };

    const totalOrdersFilter = { cancelledAt: null, ...filterDate, ...branchScope };
    const totalOrders = await Order.countDocuments(totalOrdersFilter);
    const activeOrders = await Order.countDocuments({
      cancelledAt: null,
      status: { $in: ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing', 'Ready'] },
      ...filterDate,
      ...branchScope,
    });
    const completedOrders = await Order.countDocuments({
      cancelledAt: null,
      status: 'Completed',
      ...filterDate,
      ...branchScope,
    });
    const revenueAgg = await Order.aggregate([
      { $match: { cancelledAt: null, ...filterDate, ...branchScope } },
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

router.get('/orders', authAdmin, resolveBranchContext, requireBranchAccess, async (req, res) => {
  try {
    const isSuper = req.admin?.role === 'SUPER_ADMIN';
    const filter = (isSuper && req.query.allBranches === 'true')
      ? {}
      : { branchId: req.branchId };
    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(500);
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
 * GET /admin/kitchen/stats
 * Get kitchen workload statistics
 */
router.get('/kitchen/stats', authAdmin, async (req, res) => {
  try {
    const activeOrders = await Order.find({
      status: { $in: ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing', 'Ready'] },
      cancelledAt: null,
    }).lean();

    const etaEngine = req.app.get('etaEngine');
    const queueSize = activeOrders.length;
    const loadProfile = etaEngine ? etaEngine.getLoadProfile(queueSize) : { label: queueSize > 5 ? 'High' : 'Normal', percent: Math.min(100, queueSize * 15) };

    const stats = {
      activeCount: queueSize,
      ordersInQueue: queueSize,
      kitchenLoad: loadProfile.label,
      loadPercent: loadProfile.percent,
      avgPrepTime: '15min',
    };

    res.json({ ok: true, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/orders
 * Create a manual order (Reception)
 */
router.post('/orders', authAdmin, resolveBranchContext, requireBranchAccess, async (req, res) => {
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

    // Search for existing user to link (check normalized, raw digits, etc.)
    const normPhone = normalizePhone(customer.phone);
    const rawDigits = String(customer.phone).replace(/\D/g, '');
    let existingUser = await User.findOne({
      $or: [
        { phone: normPhone },
        { phone: rawDigits },
        { phone: `+${normPhone}` },
        { phone: rawDigits.length === 10 ? `91${rawDigits}` : rawDigits },
      ]
    });

    if (!existingUser) {
      // Try searching all users and normalize both sides
      const allUsers = await User.find({}).lean();
      existingUser = allUsers.find(u => normalizePhone(u.phone) === normPhone);
      if (existingUser) {
        existingUser = await User.findById(existingUser._id);
      }
    }

    // Auto-create user if not exists so order is ALWAYS linked to an account
    let newUserCreated = false;
    if (!existingUser) {
      logger.info('ADMIN', 'Auto-creating new user account for customer from POS order', {
        name: customer.name,
        phone: normPhone,
        email: customer.email,
      });

      const generatedPassword = crypto.randomBytes(8).toString('hex');
      const userEmail = (customer.email && customer.email.trim().toLowerCase()) || `${normPhone}@customer.nerocafe.com`;
      try {
        existingUser = await User.create({
          name: customer.name,
          email: userEmail,
          phone: normPhone,
          password: generatedPassword,
          mustChangePassword: false,
        });
        newUserCreated = true;
      } catch (err) {
        // In case email collision, append random suffix
        if (err.code === 11000) {
          existingUser = await User.create({
            name: customer.name,
            email: `${normPhone}-${Date.now()}@customer.nerocafe.com`,
            phone: normPhone,
            password: generatedPassword,
            mustChangePassword: false,
          });
          newUserCreated = true;
        }
      }

      if (customer.email && newUserCreated) {
        try {
          await sendWelcomeEmail({
            to: customer.email,
            name: customer.name,
            email: customer.email,
            password: generatedPassword,
          });
        } catch {
          // Email optional
        }
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
      branchId: req.branchId,
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

    logger.success('ADMIN', `Created manual order NC-${order.orderNo}`, {
      orderId: order._id,
      orderNo: order.orderNo,
      customerName: customer.name,
      customerPhone: normPhone,
      hasUser: !!existingUser,
      userId: existingUser?._id,
      estimatedPrepTime: order.estimatedPrepTime,
    });

    const orderPayload = {
      orderId: order._id,
      orderNo: order.orderNo,
      totalPrice: order.totalPrice,
      status: order.status,
      createdAt: order.createdAt,
      items: order.items,
      customerName: order.customer?.name,
      trackingToken,
      order: order.toJSON ? order.toJSON() : order,
    };

    // Emit real-time notification to customer user room
    if (existingUser?._id) {
      logger.info('ADMIN', 'Emitting order:created to user room', {
        userId: existingUser._id,
        room: `user:${existingUser._id}`,
      });
      io?.to(`user:${existingUser._id}`).emit('order:created', orderPayload);

      // Send Push Notification
      sendUserPushNotification(existingUser._id, 'Order Placed!', {
        body: `Your order #${order.orderNo} has been placed successfully for ₹${order.totalPrice}.`,
        data: { url: `/track/${order._id}` },
        tag: `order-${order._id}`,
      }).catch(e => logger.error('NOTIFICATION', `Manual order create push notify error: ${e.message}`, { error: e }));
    }

    // Also emit to phone rooms so user device tracks even if not logged in
    io?.to(`phone:${normPhone}`).emit('order:created', orderPayload);
    if (rawDigits && rawDigits !== normPhone) {
      io?.to(`phone:${rawDigits}`).emit('order:created', orderPayload);
    }

    // Send WhatsApp notification to customer about their order
    try {
      sendPaymentSuccessMessage(normPhone, customer.name, order.orderNo, order._id, trackingToken);
      logger.success('ADMIN', `WhatsApp notification sent to: ${normPhone}`);
    } catch (e) {
      logger.warn('ADMIN', `Failed to send WhatsApp notification: ${e.message}`, { error: e });
    }

    // Send SMS notification
    try {
      await sendSMS('OrderPlaced', normPhone, { 
        orderId: order._id, 
        orderNo: order.orderNo,
        customerName: customer.name 
      });
      logger.success('ADMIN', `SMS notification sent to: ${normPhone}`);
    } catch (e) {
      logger.warn('ADMIN', `Failed to send SMS notification: ${e.message}`, { error: e });
    }

    // Send Email notification if email exists
    try {
      const recipientEmail = existingUser?.email || customer.email;
      if (recipientEmail) {
        await sendInvoiceEmail({
          to: recipientEmail,
          name: customer.name,
          orderId: order._id,
          total: order.totalPrice,
        });
        logger.success('ADMIN', `Email notification sent to: ${recipientEmail}`);
      }
    } catch (e) {
      logger.warn('ADMIN', `Failed to send email notification: ${e.message}`, { error: e });
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

    if (req.admin?.role !== 'SUPER_ADMIN' && order.branchId && order.branchId !== req.admin?.branchId) {
      return res.status(403).json({
        error: `Access Denied: You do not have permission to modify orders from branch '${order.branchId}'.`,
        code: 'CROSS_BRANCH_FORBIDDEN'
      });
    }

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

    if (req.admin?.role !== 'SUPER_ADMIN' && order.branchId && order.branchId !== req.admin?.branchId) {
      return res.status(403).json({
        error: `Access Denied: You do not have permission to modify orders from branch '${order.branchId}'.`,
        code: 'CROSS_BRANCH_FORBIDDEN'
      });
    }

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

    const { pattern = [300, 150, 300], soundLevel = 100, intensity = 'Medium' } = req.body;
    const finalPattern = Array.isArray(pattern) && pattern.length > 0 ? pattern.map(Number) : [300, 150, 300];

    const io = req.app.get('io');
    const customerRoom = `customer:${order.userId.toString()}`;
    io?.to(customerRoom).emit('customer:device_alert', {
      orderId: order._id.toString(),
      customerId: order.userId.toString(),
      pattern: finalPattern,
      soundLevel: Math.max(0, Math.min(100, Number(soundLevel) || 100)),
      intensity,
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
        pattern: finalPattern,
        soundLevel,
        intensity,
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
      pattern: finalPattern,
      soundLevel,
      intensity,
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

    if (req.admin?.role !== 'SUPER_ADMIN' && order.branchId && order.branchId !== req.admin?.branchId) {
      return res.status(403).json({
        error: `Access Denied: You do not have permission to modify orders from branch '${order.branchId}'.`,
        code: 'CROSS_BRANCH_FORBIDDEN'
      });
    }

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
          logger.warn('ADMIN', `WhatsApp send failed: ${result.error}`);
        }
      } catch (e) {
        logger.warn('ADMIN', `WhatsApp send failed: ${e.message || e}`, { error: e });
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
        logger.warn('ADMIN', `Invoice send failed: ${e.message || e}`, { error: e });
      }
    }

    // etaEngine.handleOrderStatusChange already emitted order:status and orders:update socket events above

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
      }).catch(e => logger.error('NOTIFICATION', `Status update push notify error: ${e.message}`, { error: e }));
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
      }).catch(e => logger.warn('EMAIL', `Status email failed: ${e.message}`, { error: e }));
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

    if (req.admin?.role !== 'SUPER_ADMIN' && order.branchId && order.branchId !== req.admin?.branchId) {
      return res.status(403).json({
        error: `Access Denied: You do not have permission to cancel orders from branch '${order.branchId}'.`,
        code: 'CROSS_BRANCH_FORBIDDEN'
      });
    }
    
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
        logger.warn('ADMIN', `Failed to send cancellation WhatsApp message: ${e.message || e}`, { error: e });
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
      }).catch(e => logger.error('NOTIFICATION', `Cancel push notify error: ${e.message}`, { error: e }));
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

router.get('/customers', authAdmin, resolveBranchContext, requireBranchAccess, async (req, res) => {
  try {
    const BranchCustomer = await req.getBranchModel('Customer');

    // Ensure all registered users have a corresponding Customer CRM record
    // Run in background so the response isn't delayed
    syncAllUsersToCustomers(req.branchId).catch(err =>
      logger.warn('ADMIN', `Background user-customer sync error: ${err.message}`)
    );

    const q = req.query.q?.trim();
    if (q) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cleanPhone = escaped.replace(/\D/g, '');
      const customers = await BranchCustomer.find({
        $or: [
          { name: new RegExp(escaped, 'i') },
          ...(cleanPhone ? [{ phone: new RegExp(cleanPhone, 'i') }] : []),
          { email: new RegExp(escaped, 'i') },
        ],
      }).sort({ updatedAt: -1 });
      return res.json({ customers });
    }
    // Return all customers (no hard cap) sorted by most recent activity
    const customers = await BranchCustomer.find().sort({ updatedAt: -1 });
    res.json({ customers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Manually trigger full sync of all registered users → Customer CRM records (branch-scoped) */
router.post('/customers/sync-users', authAdmin, resolveBranchContext, requireBranchAccess, async (req, res) => {
  try {
    const { User: UserModel } = await import('../models/User.js');
    const users = await UserModel.find().lean();
    const { syncUserToCustomer } = await import('../utils/customerSync.js');

    let synced = 0;
    let skipped = 0;
    for (const u of users) {
      const result = await syncUserToCustomer(u, req.branchId);
      if (result) synced++;
      else skipped++;
    }

    logger.success('ADMIN', `Synced ${synced} users to Customer CRM for branch ${req.branchId} (${skipped} skipped/errors)`);
    res.json({ ok: true, synced, skipped, total: users.length });
  } catch (e) {
    logger.error('ADMIN', `Sync users error: ${e.message}`, { error: e });
    res.status(500).json({ error: e.message });
  }
});

router.post('/customers', authAdmin, resolveBranchContext, requireBranchAccess, async (req, res) => {
  try {
    const BranchCustomer = await req.getBranchModel('Customer');
    const { name, phone, email, countryCode = '91', notes = '', birthday = null, favouriteItems = [] } = req.body;
    const normalizedEmail = String(email ?? '').trim().toLowerCase();

    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }

    const normPhone = normalizePhone(phone, countryCode);

    // Check if user account already exists (by phone or email) — link if found
    let existingUser = null;
    if (normalizedEmail) {
      existingUser = await User.findOne({
        $or: [{ phone: normPhone }, { email: normalizedEmail }]
      });
    } else {
      existingUser = await User.findOne({ phone: normPhone });
    }

    // Check if a Customer CRM record already exists by phone (branch-scoped)
    let existingCustomer = await BranchCustomer.findOne({ phone: normPhone });

    // If customer exists but has no userId link, link it now
    if (existingCustomer) {
      if (existingUser && !existingCustomer.userId) {
        existingCustomer.userId = existingUser._id;
        if (notes) existingCustomer.notes = notes;
        await existingCustomer.save();
        return res.json({ customer: existingCustomer, linked: true, generatedCredentials: false });
      }
      return res.status(400).json({ error: 'A customer record with this phone already exists.' });
    }

    // Check also by email if no phone match
    if (normalizedEmail) {
      existingCustomer = await BranchCustomer.findOne({ email: normalizedEmail });
      if (existingCustomer) {
        if (existingUser && !existingCustomer.userId) {
          existingCustomer.userId = existingUser._id;
          await existingCustomer.save();
          return res.json({ customer: existingCustomer, linked: true, generatedCredentials: false });
        }
        return res.status(400).json({ error: 'A customer record with this email already exists.' });
      }
    }

    // Also check by userId
    if (existingUser) {
      const byUserId = await BranchCustomer.findOne({ userId: existingUser._id });
      if (byUserId) {
        return res.json({ customer: byUserId, linked: true, generatedCredentials: false });
      }
    }

    let generatedPassword = '';
    let userId = null;
    let welcomeEmailSent = false;

    if (!existingUser && normalizedEmail) {
      // No existing user account — create one
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
        logger.warn('ADMIN', `Welcome email failed during customer creation: ${err.message}`, { error: err });
      }
    } else if (existingUser) {
      userId = existingUser._id;
    }

    const customer = await BranchCustomer.create({
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
    logger.error('ADMIN', `Unexpected error in customer creation: ${e.message}`, { error: e });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.patch('/customers/:id', authAdmin, resolveBranchContext, requireBranchAccess, async (req, res) => {
  try {
    const BranchCustomer = await req.getBranchModel('Customer');
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
    const customer = await BranchCustomer.findById(req.params.id);
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
      logger.error('ADMIN', `Unexpected error in customer updates: ${e.message}`, { error: e });
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.delete('/customers/:id', authAdmin, resolveBranchContext, requireBranchAccess, async (req, res) => {
  try {
    const BranchCustomer = await req.getBranchModel('Customer');
    const c = await BranchCustomer.findByIdAndDelete(req.params.id);
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
      gstEnabled: s.gstEnabled !== false,
      gstRate: s.gstRate || 5,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/shop', authAdmin, async (req, res) => {
  try {
    const { shopOpen, closedMessage, heroCardLabel, heroMenuItemId, gstEnabled, gstRate } = req.body;
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
    if (typeof gstEnabled === 'boolean') s.gstEnabled = gstEnabled;
    if (gstRate !== undefined && Number.isFinite(Number(gstRate))) s.gstRate = Math.max(0, Number(gstRate));
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
      gstEnabled: s.gstEnabled !== false,
      gstRate: s.gstRate || 5,
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
/**
 * ── Multi-Branch Management & Reporting ──────────────────────────────
 */

/**
 * GET /admin/branches
 * Returns all branches with today's performance stats.
 */
router.get('/branches', authAdmin, async (req, res) => {
  try {
    const isSuper =
      req.admin.role === 'SUPER_ADMIN' ||
      req.admin.role === 'PLATFORM_OPERATOR' ||
      req.admin.email === 'nerocafes14@gmail.com' ||
      !req.admin.allowedBranches?.length;

    const query = {};
    if (!isSuper && req.admin.allowedBranches?.length) {
      query.branchId = { $in: req.admin.allowedBranches };
    }

    const branches = await Branch.find(query).sort({ isDefault: -1, createdAt: 1 }).lean();

    // Calculate today's date bounds in local/server time
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const enriched = await Promise.all(
      branches.map(async (b) => {
        const branchScope = { branchId: b.branchId };
        const todayScope = { createdAt: { $gte: startOfDay, $lte: endOfDay }, cancelledAt: null, ...branchScope };

        const [todayOrders, activeOrders, completedOrders, revenueAgg, allTimeOrders] = await Promise.all([
          Order.countDocuments(todayScope),
          Order.countDocuments({
            status: { $in: ['Received', 'Confirmed', 'Queued', 'Preparing', 'Cooking', 'Packing', 'Ready'] },
            cancelledAt: null,
            ...branchScope,
          }),
          Order.countDocuments({
            status: 'Completed',
            createdAt: { $gte: startOfDay, $lte: endOfDay },
            cancelledAt: null,
            ...branchScope,
          }),
          Order.aggregate([
            { $match: todayScope },
            { $group: { _id: null, total: { $sum: '$totalPrice' } } },
          ]),
          Order.countDocuments({ cancelledAt: null, ...branchScope }),
        ]);

        const todayRevenue = revenueAgg[0]?.total || 0;
        const avgOrderValue = todayOrders > 0 ? Math.round(todayRevenue / todayOrders) : 0;

        return {
          ...b,
          stats: {
            todayOrders,
            todayRevenue,
            activeOrders,
            completedOrders,
            avgOrderValue,
            allTimeOrders,
          },
        };
      })
    );

    res.json({ branches: enriched });
  } catch (e) {
    logger.error('ADMIN_BRANCHES', `Failed to fetch branches: ${e.message}`, { error: e });
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/branches
 * Creates a new branch AND initializes its dedicated database.
 */
router.post('/branches', authAdmin, async (req, res) => {
  try {
    const isSuper = req.admin.role === 'SUPER_ADMIN' || req.admin.role === 'PLATFORM_OPERATOR' || req.admin.email === 'nerocafes14@gmail.com';
    if (!isSuper) {
      return res.status(403).json({ error: 'Only SUPER_ADMIN can create new branches' });
    }

    const {
      name,
      branchCode,
      displayName,
      address,
      city,
      state,
      country,
      latitude,
      longitude,
      serviceRadius,
      phone,
      email,
      openingHours,
      adminEmail,
      adminPassword,
    } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: 'Branch name is required' });
    }

    // Validate branch admin credentials if provided
    if (adminEmail) {
      const cleanAdminEmail = adminEmail.trim().toLowerCase();
      if (!cleanAdminEmail.includes('@')) {
        return res.status(400).json({ error: 'Valid admin email is required' });
      }
      if (!adminPassword || adminPassword.length < 8) {
        return res.status(400).json({ error: 'Admin password must be at least 8 characters' });
      }
      const existingAdmin = await Admin.findOne({ email: cleanAdminEmail });
      if (existingAdmin) {
        return res.status(409).json({ error: `An admin account with email '${cleanAdminEmail}' already exists` });
      }
    }

    // Auto-generate branchCode if omitted
    const code = (branchCode || name.slice(0, 5)).toUpperCase().replace(/[^A-Z0-9]/g, '');

    // Generate next available branchId
    const existingCount = await Branch.countDocuments();
    let nextNum = existingCount + 1;
    let newBranchId = `branch_${String(nextNum).padStart(3, '0')}`;
    while (await Branch.findOne({ branchId: newBranchId })) {
      nextNum++;
      newBranchId = `branch_${String(nextNum).padStart(3, '0')}`;
    }

    const dbIdentifier = `nerocafes_${newBranchId}`;

    // 1. Create central Branch registry record
    const branch = await Branch.create({
      branchId: newBranchId,
      branchCode: code,
      name: name.trim(),
      displayName: displayName?.trim() || `NeroCafes — ${name.trim()}`,
      address: address?.trim() || '',
      city: city?.trim() || 'Hyderabad',
      state: state?.trim() || 'Telangana',
      country: country?.trim() || 'India',
      latitude: Number(latitude) || 17.4486,
      longitude: Number(longitude) || 78.3908,
      serviceRadius: Number(serviceRadius) || 5000,
      phone: phone?.trim() || '',
      email: email?.trim() || '',
      openingHours: openingHours || {
        open: '10:00',
        close: '22:00',
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
      },
      status: 'ACTIVE',
      databaseIdentifier: dbIdentifier,
      isDefault: false,
    });

    // 2. Initialize Dedicated Branch Database
    logger.info('BRANCH_PROVISIONING', `Initializing database for branch ${newBranchId} (${dbIdentifier})...`);
    try {
      const BranchShopSettings = await branchDbManager.getBranchModel(newBranchId, 'ShopSettings');
      await BranchShopSettings.create({
        shopOpen: true,
        closedMessage: `${name.trim()} is currently closed.`,
        contactPhoneNumber: phone?.trim() || '',
        shopName: displayName?.trim() || `NeroCafes — ${name.trim()}`,
        etaThresholdMinutes: 20,
      });

      const BranchCounter = await branchDbManager.getBranchModel(newBranchId, 'Counter');
      await BranchCounter.create({ _id: 'orderNumber', seq: 1000 });

      logger.success('BRANCH_PROVISIONING', `Dedicated database '${dbIdentifier}' successfully created and initialized.`);
    } catch (dbErr) {
      logger.error('BRANCH_PROVISIONING', `Failed to initialize branch database collections: ${dbErr.message}`);
    }

    // 3. Create Branch Admin account if credentials provided
    let branchAdmin = null;
    if (adminEmail?.trim()) {
      try {
        branchAdmin = await Admin.create({
          name: `${name.trim()} Admin`,
          email: adminEmail.trim().toLowerCase(),
          password: adminPassword,
          role: 'BRANCH_ADMIN',
          branchId: newBranchId,
          allowedBranches: [newBranchId],
        });
        logger.success('BRANCH_PROVISIONING', `Branch admin '${adminEmail.trim().toLowerCase()}' created for ${newBranchId}`);
      } catch (adminErr) {
        logger.error('BRANCH_PROVISIONING', `Failed to create branch admin: ${adminErr.message}`);
      }
    }

    // Refresh memory cache
    await branchDbManager.refreshBranchCache();

    AuditLog.create({
      action: 'CREATE_BRANCH',
      userType: 'admin',
      actorName: req.admin.email,
      target: `Branch: ${newBranchId} (${name})`,
      ip: req.headers['x-forwarded-for'] || req.ip || '',
      path: req.originalUrl,
      method: req.method,
      status: 201,
      success: true,
      timestamp: new Date(),
    }).catch(() => {});

    res.status(201).json({
      branch,
      branchAdmin: branchAdmin ? { email: branchAdmin.email, role: branchAdmin.role, branchId: branchAdmin.branchId } : null,
      message: `Branch '${name}' created and database '${dbIdentifier}' initialized successfully.${branchAdmin ? ` Admin login: ${branchAdmin.email}` : ''}`,
    });
  } catch (e) {
    logger.error('ADMIN_BRANCHES', `Failed to create branch: ${e.message}`, { error: e });
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /admin/branches/:branchId/daily-orders
 * Returns list of orders for a specific branch and date.
 */
router.get('/branches/:branchId/daily-orders', authAdmin, resolveBranchContext, requireBranchAccess, async (req, res) => {
  try {
    const { branchId } = req.params;
    const { date, status, limit = 100, page = 1 } = req.query;

    let targetDate = new Date();
    if (date) {
      const parsed = new Date(date);
      if (!isNaN(parsed.getTime())) targetDate = parsed;
    }

    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const filter = {
      branchId,
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    };

    if (status && status !== 'ALL') {
      filter.status = status;
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [orders, totalCount, revenueAgg] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Order.countDocuments(filter),
      Order.aggregate([
        { $match: { ...filter, cancelledAt: null } },
        { $group: { _id: null, total: { $sum: '$totalPrice' } } },
      ]),
    ]);

    const totalRevenue = revenueAgg[0]?.total || 0;

    res.json({
      branchId,
      date: startOfDay.toISOString().split('T')[0],
      totalCount,
      totalRevenue,
      page: Number(page),
      totalPages: Math.ceil(totalCount / Number(limit)) || 1,
      orders,
    });
  } catch (e) {
    logger.error('ADMIN_BRANCHES', `Failed to fetch branch daily orders: ${e.message}`, { error: e });
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /admin/branches/:branchId
 * Updates branch information.
 */
router.patch('/branches/:branchId', authAdmin, async (req, res) => {
  try {
    const { branchId } = req.params;
    const isSuper = req.admin.role === 'SUPER_ADMIN' || req.admin.role === 'PLATFORM_OPERATOR' || req.admin.email === 'nerocafes14@gmail.com';

    if (!isSuper && req.admin.branchId !== branchId) {
      return res.status(403).json({ error: 'Permission denied to update this branch' });
    }

    const allowedUpdates = [
      'name',
      'displayName',
      'address',
      'city',
      'state',
      'latitude',
      'longitude',
      'serviceRadius',
      'phone',
      'email',
      'openingHours',
      'status',
    ];

    const updates = {};
    for (const key of allowedUpdates) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }

    const branch = await Branch.findOneAndUpdate({ branchId }, { $set: updates }, { new: true });
    if (!branch) {
      return res.status(404).json({ error: 'Branch not found' });
    }

    await branchDbManager.refreshBranchCache();
    res.json({ branch });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /admin/branches/:branchId
 * Deletes a branch AND drops its dedicated database and data.
 */
router.delete('/branches/:branchId', authAdmin, async (req, res) => {
  try {
    const isSuper = req.admin.role === 'SUPER_ADMIN' || req.admin.role === 'PLATFORM_OPERATOR' || req.admin.email === 'nerocafes14@gmail.com';
    if (!isSuper) {
      return res.status(403).json({ error: 'Only SUPER_ADMIN can delete branches' });
    }

    const { branchId } = req.params;
    if (branchId === 'branch_001') {
      return res.status(400).json({ error: 'Primary branch branch_001 cannot be deleted' });
    }

    const branch = await Branch.findOne({ branchId });
    if (!branch) {
      return res.status(404).json({ error: 'Branch not found' });
    }

    // Drop the branch's dedicated database and all branch data
    await branchDbManager.deleteBranchDb(branchId, branch.databaseIdentifier);

    // Delete all branch admin accounts tied to this branch
    const deletedAdmins = await Admin.deleteMany({ branchId, role: 'BRANCH_ADMIN' });
    if (deletedAdmins.deletedCount > 0) {
      logger.info('BRANCH_PROVISIONING', `Deleted ${deletedAdmins.deletedCount} admin account(s) for branch ${branchId}`);
    }

    // Delete branch registry document
    await Branch.findOneAndDelete({ branchId });
    await branchDbManager.refreshBranchCache();

    res.json({ message: `Branch '${branch.name}' (${branchId}) and all associated database data have been completely deleted.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
