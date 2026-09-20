import crypto from 'crypto';
import { EmailVerificationToken } from '../models/EmailVerificationToken.js';

const TOKEN_TTL_MS = 5 * 60 * 1000;
const TOKEN_COOLDOWN_MS = 60 * 1000;
const TOKEN_COOLDOWN_MESSAGES = {
  activation: 'A verification email was recently sent. Please wait before requesting another.',
  'password-reset': 'A reset email was recently sent. Please wait before requesting another.',
  'email-change': 'A verification email was recently sent. Please wait before requesting another.',
};

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token ?? '').trim()).digest('hex');
}

// Generate a secure random token
export function generateSecureToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function invalidateExistingTokens(email, purpose) {
  await EmailVerificationToken.updateMany(
    {
      email,
      purpose,
      used: false,
    },
    {
      $set: {
        used: true,
        invalidatedAt: new Date(),
      },
    }
  );
}

async function createScopedToken(email, purpose) {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error('Email is required');
  }

  const recentToken = await EmailVerificationToken.findOne({
    email: normalizedEmail,
    purpose,
    createdAt: { $gte: new Date(Date.now() - TOKEN_COOLDOWN_MS) },
  }).sort({ createdAt: -1 });

  if (recentToken) {
    const err = new Error(TOKEN_COOLDOWN_MESSAGES[purpose] || 'An email was recently sent. Please wait before requesting another.');
    err.statusCode = 429;
    throw err;
  }

  const token = generateSecureToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await invalidateExistingTokens(normalizedEmail, purpose);
  await EmailVerificationToken.create({
    email: normalizedEmail,
    token: tokenHash,
    purpose,
    expiresAt,
    used: false,
  });

  return token;
}

// Create an activation/login token that expires in 5 minutes.
export async function createEmailVerificationToken(email) {
  return createScopedToken(email, 'activation');
}

// Create a password reset token that expires in 5 minutes.
export async function createPasswordResetToken(email) {
  return createScopedToken(email, 'password-reset');
}

function buildVerificationQuery(token, purpose) {
  return {
    token: hashToken(token),
    purpose,
    used: false,
    expiresAt: { $gt: new Date() },
  };
}

// Verify an email verification token (activation flow).
export async function verifyEmailToken(token) {
  const tokenDoc = await EmailVerificationToken.findOne(buildVerificationQuery(token, 'activation'));

  if (!tokenDoc) {
    return null;
  }

  tokenDoc.used = true;
  tokenDoc.invalidatedAt = new Date();
  await tokenDoc.save();

  return tokenDoc.email;
}

export async function verifyPasswordResetToken(token, email) {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }

  return EmailVerificationToken.findOne({
    ...buildVerificationQuery(token, 'password-reset'),
    email: normalizedEmail,
  });
}

export async function consumePasswordResetToken(token, email) {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }

  const tokenDoc = await EmailVerificationToken.findOne({
    ...buildVerificationQuery(token, 'password-reset'),
    email: normalizedEmail,
  });

  if (!tokenDoc) {
    return null;
  }

  tokenDoc.used = true;
  tokenDoc.invalidatedAt = new Date();
  await tokenDoc.save();

  return tokenDoc.email;
}

// Clean up expired tokens (call this periodically)
export async function cleanupExpiredTokens() {
  const result = await EmailVerificationToken.deleteMany({
    expiresAt: { $lt: new Date() }
  });
  return result.deletedCount;
}
