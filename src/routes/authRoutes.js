import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { User } from '../models/User.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { sendWelcomeEmail, sendPasswordResetEmail, sendOtpEmail } from '../utils/emailPlaceholder.js';
import {
  verifyEmailToken,
  createPasswordResetToken,
  verifyPasswordResetToken,
  consumePasswordResetToken,
} from '../utils/emailVerification.js';
import { authUser, requireUser } from '../middleware/authUser.js';
import { uploadAvatarMiddleware } from '../middleware/uploadAvatar.js';
import { deleteLocalAvatarFile } from '../utils/avatarStorage.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';
import { syncUserToCustomer } from '../utils/customerSync.js';

const router = Router();

const ACCESS_TOKEN_EXPIRY = '15m';

function signAccessToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

async function issueTokenPair(user, deviceInfo = '') {
  const accessToken = signAccessToken(user);
  const refreshToken = await RefreshToken.createForUser(user._id, 'user', deviceInfo);
  return { accessToken, refreshToken };
}

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || undefined);

/* ── Auth routes ─────────────────────────────────── */

router.post('/signup', async (req, res) => {
  try {
    logger.info('AUTH', 'Registration Request Received');
    const rawName = String(req.body?.name ?? '');
    const rawPhone = String(req.body?.phone ?? '');
    // Accept optional email/password from legacy clients, but don't require them
    const rawEmail = String(req.body?.email ?? '');
    const rawPassword = String(req.body?.password ?? '');

    const name = rawName.trim();
    let phone = rawPhone.trim().replace(/\D/g, ''); // strip non-digits

    // Validation: name + Indian 10-digit phone only
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (name.length > 100) return res.status(400).json({ error: 'Name too long' });

    // Normalise phone: strip leading +91 or 91 prefix if given
    if (phone.startsWith('91') && phone.length === 12) phone = phone.slice(2);
    if (phone.length !== 10 || !/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: 'Enter a valid 10-digit Indian phone number' });
    }

    // Prefix with 91 for storage
    const normalizedPhone = `91${phone}`;

    // Generate internal email & password if not provided by client
    const email = rawEmail.trim().toLowerCase() || `${normalizedPhone}@customer.nerocafe.com`;
    const password = rawPassword || crypto.randomBytes(16).toString('hex');

    logger.debug('AUTH', 'Validation Success');

    // Check if user with this phone already exists
    const existingByPhone = await User.findOne({ phone: normalizedPhone });
    if (existingByPhone) {
      // Phone already registered — log them in seamlessly
      logger.info('AUTH', 'Phone Already Registered, Auto-Login', { phone: normalizedPhone });
      const deviceInfo = req.headers['user-agent'] || '';
      const { accessToken, refreshToken } = await issueTokenPair(existingByPhone, deviceInfo);
      return res.status(200).json({ user: existingByPhone.toJSON(), token: accessToken, refreshToken });
    }

    // Check email collision (defensive)
    const existingByEmail = await User.findOne({ email });
    if (existingByEmail) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const user = await User.create({ name, email, phone: normalizedPhone, password });
    logger.success('AUTH', 'Customer Created', { userId: user._id });

    // Sync to Customer CRM so this user appears in admin customer list immediately
    syncUserToCustomer(user).catch(err =>
      logger.warn('AUTH', `Customer sync skipped: ${err.message}`)
    );

    const deviceInfo = req.headers['user-agent'] || '';
    const { accessToken, refreshToken } = await issueTokenPair(user, deviceInfo);
    logger.info('AUTH', 'JWT Generated', { userId: user._id });

    try {
      logger.info('AUTH', 'Verification Email Queued', { email });
      sendWelcomeEmail({ to: email, name }).then(() => {
        logger.success('AUTH', 'Verification Email Sent', { email });
      }).catch(err => {
        logger.error('AUTH', 'Verification Email Failed', { error: err });
      });
    } catch {
      // Email delivery is optional. Do not block account creation or ordering.
    }
    logger.success('AUTH', 'Login Success (Signup Redirect)', { userId: user._id });
    res.status(201).json({ user: user.toJSON(), token: accessToken, refreshToken });
  } catch (e) {
    logger.error('AUTH', 'Signup Failed', { error: e });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/**
 * POST /api/auth/send-otp
 * Send 6-digit login OTP to registered email (or provided email)
 */
router.post(['/send-otp', '/login/send-otp'], authLimiter, async (req, res) => {
  try {
    const rawIdentifier = String(req.body?.identifier || req.body?.phone || req.body?.email || '').trim();
    if (!rawIdentifier) {
      return res.status(400).json({ error: 'Please enter your phone number or email address' });
    }

    let user = null;
    let isPhone = false;
    let cleanPhone = '';

    // Check if input is phone number
    const digits = rawIdentifier.replace(/\D/g, '');
    if (/^[6-9]\d{9}$/.test(digits) || (digits.startsWith('91') && digits.length === 12 && /^[6-9]\d{9}$/.test(digits.slice(2)))) {
      isPhone = true;
      cleanPhone = digits.length === 12 ? digits.slice(2) : digits;
      const normalizedPhone = `91${cleanPhone}`;
      user = await User.findOne({
        $or: [
          { phone: normalizedPhone },
          { phone: cleanPhone },
          { phone: `+${normalizedPhone}` },
          { phone: `+91${cleanPhone}` },
        ],
      });
    } else if (rawIdentifier.includes('@')) {
      const email = rawIdentifier.toLowerCase().trim();
      user = await User.findOne({ email });
    } else {
      return res.status(400).json({ error: 'Enter a valid 10-digit Indian phone number or email address' });
    }

    if (!user) {
      return res.status(404).json({
        error: isPhone
          ? 'No account found with this phone number. Please sign up first.'
          : 'No account found with this email. Please sign up first.',
      });
    }

    // Generate 6-digit numeric OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
    user.otpHash = otpHash;
    user.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await user.save();

    const hasRealEmail = user.email && !user.email.endsWith('@customer.nerocafe.com');

    if (hasRealEmail) {
      // Send OTP to registered email
      const [namePart, domain] = user.email.split('@');
      const maskedEmail = (namePart.length > 2 ? namePart.slice(0, 2) : namePart[0]) + '***@' + domain;

      const emailRes = await sendOtpEmail({ to: user.email, name: user.name, otp });
      logger.success('AUTH', `Sent Login OTP to email ${user.email}`, { userId: user._id });

      return res.json({
        ok: true,
        message: `Verification code sent to registered email ${maskedEmail}`,
        maskedEmail,
        hasEmail: true,
        identifier: isPhone ? `91${cleanPhone}` : user.email,
        ...(emailRes?.devMode ? { devOtp: otp } : {}),
      });
    } else {
      // User does not have a real email attached yet
      logger.info('AUTH', `User has no custom email linked, OTP generated for phone ${user.phone}`, { userId: user._id });
      return res.json({
        ok: true,
        needsEmail: true,
        message: 'Enter your email address to receive your login verification code.',
        hasEmail: false,
        phone: user.phone,
        identifier: user.phone,
        devOtp: process.env.NODE_ENV !== 'production' ? otp : undefined,
      });
    }
  } catch (e) {
    logger.error('AUTH', 'Send OTP error:', { error: e });
    res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
  }
});

/**
 * POST /api/auth/verify-otp
 * Verify 6-digit OTP and sign in user without password
 */
router.post(['/verify-otp', '/login/verify-otp'], authLimiter, async (req, res) => {
  try {
    const rawIdentifier = String(req.body?.identifier || req.body?.phone || req.body?.email || '').trim();
    const rawOtp = String(req.body?.otp || '').trim();
    const optionalEmail = String(req.body?.email || '').trim().toLowerCase();

    if (!rawIdentifier || !rawOtp) {
      return res.status(400).json({ error: 'Identifier and verification code are required' });
    }

    let user = null;
    const digits = rawIdentifier.replace(/\D/g, '');
    if (/^[6-9]\d{9}$/.test(digits) || (digits.startsWith('91') && digits.length === 12)) {
      const cleanPhone = digits.length === 12 ? digits.slice(2) : digits;
      const normalizedPhone = `91${cleanPhone}`;
      user = await User.findOne({
        $or: [
          { phone: normalizedPhone },
          { phone: cleanPhone },
          { phone: `+${normalizedPhone}` },
          { phone: `+91${cleanPhone}` },
        ],
      });
    } else if (rawIdentifier.includes('@')) {
      user = await User.findOne({ email: rawIdentifier.toLowerCase() });
    }

    if (!user) {
      return res.status(404).json({ error: 'User account not found' });
    }

    if (!user.otpHash || !user.otpExpiresAt || new Date(user.otpExpiresAt) < new Date()) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    const inputHash = crypto.createHash('sha256').update(rawOtp).digest('hex');
    if (inputHash !== user.otpHash) {
      return res.status(400).json({ error: 'Invalid verification code. Please check and try again.' });
    }

    // Clear OTP
    user.otpHash = null;
    user.otpExpiresAt = null;

    // If user provided email during OTP step, save it
    if (optionalEmail && optionalEmail.includes('@') && user.email.endsWith('@customer.nerocafe.com')) {
      const emailInUse = await User.findOne({ email: optionalEmail, _id: { $ne: user._id } });
      if (!emailInUse) {
        user.email = optionalEmail;
      }
    }

    await user.save();

    const deviceInfo = req.headers['user-agent'] || '';
    const { accessToken, refreshToken } = await issueTokenPair(user, deviceInfo);
    logger.success('AUTH', 'OTP Login Success', { userId: user._id, email: user.email });

    res.json({
      user: user.toJSON(),
      token: accessToken,
      refreshToken,
      hasCustomEmail: user.email && !user.email.endsWith('@customer.nerocafe.com'),
    });
  } catch (e) {
    logger.error('AUTH', 'Verify OTP error:', { error: e });
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

/**
 * PATCH /api/auth/me/email
 * Update user's email address (for post-signup email prompt)
 */
router.patch('/me/email', authUser, requireUser, async (req, res) => {
  try {
    const rawEmail = String(req.body?.email || '').trim().toLowerCase();
    if (!rawEmail || !rawEmail.includes('@')) {
      return res.status(400).json({ error: 'Valid email address is required' });
    }

    const existing = await User.findOne({ email: rawEmail, _id: { $ne: req.user._id } });
    if (existing) {
      return res.status(409).json({ error: 'This email is already registered with another account' });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.email = rawEmail;
    await user.save();

    logger.success('AUTH', `Updated email for user ${user._id} to ${rawEmail}`);
    res.json({ ok: true, user: user.toJSON() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const rawEmail = String(req.body?.email ?? '');
    const rawPassword = String(req.body?.password ?? '');

    const email = rawEmail.trim().toLowerCase();
    const password = rawPassword;

    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      logger.warn('AUTH', 'Login Failed (Invalid Credentials)', { email });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const deviceInfo = req.headers['user-agent'] || '';
    const { accessToken, refreshToken } = await issueTokenPair(user, deviceInfo);
    logger.success('AUTH', 'Login Success', { userId: user._id });
    res.json({ user: user.toJSON(), token: accessToken, refreshToken });
  } catch (e) {
    logger.error('AUTH', 'Login Error', { error: e });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    logger.info('AUTH', 'Password Reset Requested', { email });
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(200).json({ ok: true, message: 'If the email address exists, a reset link has been sent.' });
    }

    const resetToken = await createPasswordResetToken(email);
    const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    const resetLink = `${clientOrigin}/auth?token=${resetToken}&email=${encodeURIComponent(email)}&purpose=password-reset`;

    logger.info('AUTH', 'Verification Email Queued', { email });
    const emailResult = await sendPasswordResetEmail({
      to: email,
      name: user.name || 'NeroCafes Member',
      resetLink,
    });

    if (!emailResult?.ok) {
      logger.error('AUTH', 'Reset Email Delivery Failed', { error: emailResult?.error });
      return res.status(502).json({ error: "We couldn't send the email. Please try again." });
    }

    logger.success('AUTH', 'Verification Email Sent', { email });
    res.status(200).json({ ok: true, message: 'Reset email sent successfully. Please check your inbox. You can request another email in 60 seconds.' });
  } catch (e) {
    if (e?.statusCode === 429) {
      return res.status(429).json({ error: e.message });
    }
    logger.error('AUTH', 'Forgot Password Error', { error: e });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const token = String(req.body?.token ?? '');
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const newPassword = String(req.body?.newPassword ?? '');

    if (!token || !email || !newPassword) {
      return res.status(400).json({ error: 'Token, email and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const tokenDoc = await verifyPasswordResetToken(token, email);
    if (!tokenDoc) {
      return res.status(410).json({ error: 'This reset link has expired.' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const consumedEmail = await consumePasswordResetToken(token, email);
    if (!consumedEmail) {
      return res.status(410).json({ error: 'This reset link has expired.' });
    }

    user.password = newPassword;
    user.mustChangePassword = false;
    await user.save();

    logger.success('AUTH', 'Password Changed', { userId: user._id });
    res.json({ ok: true, message: 'Password updated successfully' });
  } catch (e) {
    logger.error('AUTH', 'Reset Password Error', { error: e });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/resend-activation', authLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const emailResult = await sendWelcomeEmail({
      to: user.email,
      name: user.name,
      email: user.email,
    });

    if (!emailResult?.ok) {
      logger.error('AUTH', `Welcome email delivery failed: ${emailResult?.error || 'Unknown SMTP error'}`);
      return res.status(502).json({ error: "We couldn't send the email. Please try again." });
    }

    res.json({ ok: true, message: 'Activation link sent successfully' });
  } catch (e) {
    if (e?.statusCode === 429) {
      return res.status(429).json({ error: e.message });
    }
    if (import.meta.env?.DEV) {
      logger.error('AUTH', `Unexpected error in resend activation: ${e.message}`, { error: e });
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/google', authLimiter, async (req, res) => {
  try {
    const { credential, idToken } = req.body;
    
    if (!credential && !idToken) {
      return res.status(400).json({ error: 'Google credential or idToken required' });
    }

    let payload;
    let tokenToUse = idToken || credential;

    // Check if token is a JWT (ID token) by counting dots
    const isJWT = (token) => (token?.match(/\./g) || []).length === 2;

    // If we got a JWT (either as idToken or credential), verify it as JWT
    if (isJWT(tokenToUse)) {
      try {
        logger.info('AUTH', 'Verifying Google authentication as JWT ID token');
        const ticket = await googleClient.verifyIdToken({
          idToken: tokenToUse,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
        payload = ticket.getPayload();
        logger.success('AUTH', `Google JWT verification successful: ${payload?.email}`);
      } catch (verifyErr) {
        logger.error('AUTH', `Google JWT verification failed: ${verifyErr.message}`, { error: verifyErr });
        throw new Error(`Failed to verify Google token: ${verifyErr.message}`);
      }
    } else {
      // It's an access token, use UserInfo endpoint
      try {
        logger.info('AUTH', 'Verifying Google authentication as access token via UserInfo endpoint');
        const googleRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokenToUse}` },
          timeout: 5000,
        });

        if (!googleRes.ok) {
          const errText = await googleRes.text();
          logger.error('AUTH', `Google UserInfo returned error ${googleRes.status}: ${errText}`);
          throw new Error(`Google UserInfo returned ${googleRes.status}: ${errText}`);
        }

        payload = await googleRes.json();
        logger.success('AUTH', `Google access token verification successful: ${payload?.email}`);
      } catch (accessErr) {
        logger.error('AUTH', `Google access token verification failed: ${accessErr.message}`, { error: accessErr });
        throw new Error(`Failed to verify Google access token: ${accessErr.message}`);
      }
    }

    const email = String(payload?.email ?? '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Google account email missing' });
    }

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        name: payload?.name || 'Google User',
        email,
        phone: '0000000000',
        password: crypto.randomBytes(24).toString('hex'),
        avatarUrl: payload?.picture || '',
      });
    } else if (payload.picture && !user.avatarUrl) {
      user.avatarUrl = payload.picture;
      await user.save();
    }

    // Sync to Customer CRM so user appears in admin customer list
    syncUserToCustomer(user).catch(err =>
      logger.warn('AUTH', `Google auth customer sync skipped: ${err.message}`)
    );

    const deviceInfo = req.headers['user-agent'] || '';
    const { accessToken, refreshToken } = await issueTokenPair(user, deviceInfo);
    res.json({ user: user.toJSON(), token: accessToken, refreshToken });
  } catch (e) {
    if (import.meta.env?.DEV) {
      logger.error('AUTH', `Google Auth error: ${e.message}`, { error: e });
    }
    res.status(401).json({ error: 'Something went wrong. Please try again.' });
  }
});

/* ── Refresh token endpoint ───────────────────────────────────── */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken: rt } = req.body;
    if (!rt) return res.status(400).json({ error: 'Refresh token required' });

    const doc = await RefreshToken.verifyToken(rt, 'user');
    if (!doc) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    const user = await User.findById(doc.userId);
    if (!user) {
      await RefreshToken.revokeToken(rt);
      return res.status(401).json({ error: 'User not found' });
    }

    /* Rotate refresh token – revoke old, issue new pair */
    await RefreshToken.revokeToken(rt);
    const deviceInfo = req.headers['user-agent'] || '';
    const { accessToken, refreshToken } = await issueTokenPair(user, deviceInfo);
    logger.success('AUTH', 'Token Refreshed', { userId: user._id });
    res.json({ token: accessToken, refreshToken });
  } catch (e) {
    logger.error('AUTH', 'Token Refresh Error', { error: e });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/* ── Logout (revoke refresh token) ────────────────────────────── */
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken: rt } = req.body;
    if (rt) await RefreshToken.revokeToken(rt);
    logger.success('AUTH', 'Logout');
    res.json({ ok: true });
  } catch (e) {
    logger.error('AUTH', 'Logout Error', { error: e });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/* ── Protected user routes ────────────────────────────────────── */

router.get('/me', authUser, requireUser, (req, res) => {
  res.json({ user: req.user });
});

router.post('/change-password', authUser, requireUser, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!newPassword) {
      return res.status(400).json({ error: 'New password is required' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const providedOldPassword = String(oldPassword || '').trim();
    if (providedOldPassword) {
      const isMatch = await user.comparePassword(providedOldPassword);
      if (!isMatch) {
        return res.status(400).json({ error: 'Incorrect old password' });
      }
    }

    user.password = newPassword;
    user.mustChangePassword = false;
    await user.save();

    res.json({ ok: true, user: user.toJSON() });
  } catch (e) {
    if (import.meta.env?.DEV) {
      logger.error('AUTH', `Unexpected error in change password: ${e.message}`, { error: e });
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.patch('/me', authUser, requireUser, async (req, res) => {
  try {
    const { name, phone } = req.body || {};
    if (phone !== undefined && !String(phone).trim()) {
      return res.status(400).json({ error: 'Phone is required' });
    }
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (name !== undefined) user.name = String(name).trim().slice(0, 100) || user.name;
    if (phone !== undefined) user.phone = String(phone).trim().slice(0, 20);
    await user.save();
    res.json({ user: user.toJSON() });
  } catch (e) {
    if (import.meta.env?.DEV) {
      logger.error('AUTH', `Unexpected error in profile update: ${e.message}`, { error: e });
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post(
  '/me/avatar',
  authUser,
  requireUser,
  (req, res, next) => {
    uploadAvatarMiddleware.single('avatar')(req, res, (err) => {
      if (err) {
        const message = err.code === 'LIMIT_FILE_SIZE'
          ? 'Image file size must be under 5MB'
          : err.message || 'Upload failed. Please try again.';
        logger.error('AUTH', `Avatar upload error: ${message}`, { error: err });
        return res.status(400).json({ error: message });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const user = await User.findById(req.user._id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      await deleteLocalAvatarFile(user.avatarUrl);
      user.avatarUrl = `/uploads/avatars/${req.file.filename}`;
      await user.save();
      logger.success('AUTH', `Avatar uploaded successfully for user ${user._id}: ${user.avatarUrl}`);
      res.json({ user: user.toJSON(), avatarUrl: user.avatarUrl });
    } catch (e) {
      logger.error('AUTH', `Unexpected error in avatar upload: ${e.message}`, { error: e });
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }
);

router.delete('/me/avatar', authUser, requireUser, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await deleteLocalAvatarFile(user.avatarUrl);
    user.avatarUrl = '';
    await user.save();
    logger.success('AUTH', `Avatar removed for user ${user._id}`);
    res.json({ user: user.toJSON(), avatarUrl: '' });
  } catch (e) {
    logger.error('AUTH', `Unexpected error in delete avatar: ${e.message}`, { error: e });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/* ── Email Token Verification ───────────────────────────────────── */
router.get('/verify-email-token', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const email = await verifyEmailToken(token);
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    if (!normalizedEmail) {
      return res.status(410).json({ error: 'This activation link has expired.' });
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      valid: true,
      email: user.email,
      message: 'Token verified successfully',
    });
  } catch (e) {
    if (import.meta.env?.DEV) {
      logger.error('AUTH', `Unexpected error in email token verification: ${e.message}`, { error: e });
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.get('/verify-password-reset-token', async (req, res) => {
  try {
    const { token, email } = req.query;
    if (!token || !email) {
      return res.status(400).json({ error: 'Token and email are required' });
    }

    const tokenDoc = await verifyPasswordResetToken(token, email);
    if (!tokenDoc) {
      return res.status(410).json({ error: 'This reset link has expired.' });
    }

    const user = await User.findOne({ email: String(email).trim().toLowerCase() });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      valid: true,
      email: user.email,
      message: 'Reset token verified successfully',
    });
  } catch (e) {
    if (import.meta.env?.DEV) {
      logger.error('AUTH', `Unexpected error in password reset token verification: ${e.message}`, { error: e });
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
