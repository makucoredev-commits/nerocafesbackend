import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { User } from '../models/User.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { sendWelcomeEmail, sendPasswordResetEmail } from '../utils/emailPlaceholder.js';
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
    const rawName = String(req.body?.name ?? '');
    const rawEmail = String(req.body?.email ?? '');
    const rawPhone = String(req.body?.phone ?? '');
    const rawPassword = String(req.body?.password ?? '');

    const name = rawName.trim();
    const email = rawEmail.trim().toLowerCase();
    const phone = rawPhone.trim();
    const password = rawPassword;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    if (name.length > 100) return res.status(400).json({ error: 'Name too long' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (password.length > 128) return res.status(400).json({ error: 'Password too long' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });

    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ error: 'Email already registered' });

    const user = await User.create({ name, email, phone, password });
    const deviceInfo = req.headers['user-agent'] || '';
    const { accessToken, refreshToken } = await issueTokenPair(user, deviceInfo);
    try {
      await sendWelcomeEmail({ to: email, name });
    } catch {
      // Email delivery is optional. Do not block account creation or ordering.
    }
    res.status(201).json({ user: user.toJSON(), token: accessToken, refreshToken });
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.error('[Auth Signup] Unexpected error:', e);
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
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
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const deviceInfo = req.headers['user-agent'] || '';
    const { accessToken, refreshToken } = await issueTokenPair(user, deviceInfo);
    res.json({ user: user.toJSON(), token: accessToken, refreshToken });
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.error('[Auth Login] Unexpected error:', e);
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(200).json({ ok: true, message: 'If the email address exists, a reset link has been sent.' });
    }

    const resetToken = await createPasswordResetToken(email);
    const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    const resetLink = `${clientOrigin}/auth?token=${resetToken}&email=${encodeURIComponent(email)}&purpose=password-reset`;

    const emailResult = await sendPasswordResetEmail({
      to: email,
      name: user.name || 'NeroCafes Member',
      resetLink,
    });

    if (!emailResult?.ok) {
      console.error('[Auth Forgot Password] Reset email delivery failed:', emailResult?.error || 'Unknown SMTP error');
      return res.status(502).json({ error: "We couldn't send the email. Please try again." });
    }

    res.status(200).json({ ok: true, message: 'Reset email sent successfully. Please check your inbox. You can request another email in 60 seconds.' });
  } catch (e) {
    if (e?.statusCode === 429) {
      return res.status(429).json({ error: e.message });
    }
    if (import.meta.env?.DEV) {
      console.error('[Auth Forgot Password] Unexpected error:', e);
    }
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

    res.json({ ok: true, message: 'Password updated successfully' });
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.error('[Auth Reset Password] Unexpected error:', e);
    }
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
      console.error('[Auth Resend Activation] Welcome email delivery failed:', emailResult?.error || 'Unknown SMTP error');
      return res.status(502).json({ error: "We couldn't send the email. Please try again." });
    }

    res.json({ ok: true, message: 'Activation link sent successfully' });
  } catch (e) {
    if (e?.statusCode === 429) {
      return res.status(429).json({ error: e.message });
    }
    if (import.meta.env?.DEV) {
      console.error('[Auth Resend Activation] Unexpected error:', e);
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
        console.log('[Google Auth] Verifying as JWT ID token');
        const ticket = await googleClient.verifyIdToken({
          idToken: tokenToUse,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
        payload = ticket.getPayload();
        console.log('[Google Auth] JWT verification successful for:', payload?.email);
      } catch (verifyErr) {
        console.error('[Google Auth] JWT verification failed:', verifyErr.message);
        throw new Error(`Failed to verify Google token: ${verifyErr.message}`);
      }
    } else {
      // It's an access token, use UserInfo endpoint
      try {
        console.log('[Google Auth] Verifying as access token via UserInfo endpoint');
        const googleRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokenToUse}` },
          timeout: 5000,
        });

        if (!googleRes.ok) {
          const errText = await googleRes.text();
          console.error('[Google Auth] UserInfo error:', googleRes.status, errText);
          throw new Error(`Google UserInfo returned ${googleRes.status}: ${errText}`);
        }

        payload = await googleRes.json();
        console.log('[Google Auth] Access token verification successful for:', payload?.email);
      } catch (accessErr) {
        console.error('[Google Auth] Access token verification failed:', accessErr.message);
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
      // Opportunistically update avatar if not set
      user.avatarUrl = payload.picture;
      await user.save();
    }

    const deviceInfo = req.headers['user-agent'] || '';
    const { accessToken, refreshToken } = await issueTokenPair(user, deviceInfo);
    res.json({ user: user.toJSON(), token: accessToken, refreshToken });
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.error('[Google Auth] Error:', e);
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
    res.json({ token: accessToken, refreshToken });
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.error('[Auth Refresh] Unexpected error:', e);
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/* ── Logout (revoke refresh token) ────────────────────────────── */
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken: rt } = req.body;
    if (rt) await RefreshToken.revokeToken(rt);
    res.json({ ok: true });
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.error('[Auth Logout] Unexpected error:', e);
    }
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
      console.error('[Auth Change Password] Unexpected error:', e);
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
      console.error('[Auth Profile Update] Unexpected error:', e);
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
      if (err) return res.status(400).json({ error: 'Upload failed. Please try again.' });
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
      res.json({ user: user.toJSON() });
    } catch (e) {
      if (import.meta.env?.DEV) {
        console.error('[Auth Avatar Upload] Unexpected error:', e);
      }
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
    res.json({ user: user.toJSON() });
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.error('[Auth Delete Avatar] Unexpected error:', e);
    }
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
      console.error('[Auth Verify Email Token] Unexpected error:', e);
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
      console.error('[Auth Verify Password Reset Token] Unexpected error:', e);
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
