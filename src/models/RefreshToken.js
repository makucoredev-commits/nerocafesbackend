import mongoose from 'mongoose';
import crypto from 'crypto';

const refreshTokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  userType: { type: String, enum: ['user', 'admin'], required: true },
  deviceInfo: { type: String, default: '' },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

/* Auto-delete expired tokens via TTL index */
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Generate a cryptographically-secure refresh token string.
 */
refreshTokenSchema.statics.generateToken = function () {
  return crypto.randomBytes(40).toString('hex');
};

/**
 * Create and persist a new refresh token for a given user.
 */
refreshTokenSchema.statics.createForUser = async function (userId, userType, deviceInfo = '') {
  const token = this.generateToken();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000 * 2); // 2 years persistence
  await this.create({ token, userId, userType, deviceInfo, expiresAt });
  return token;
};

/**
 * Validate a refresh token string. Returns the document or null.
 */
refreshTokenSchema.statics.verifyToken = async function (token, userType) {
  const doc = await this.findOne({ token, userType, expiresAt: { $gt: new Date() } });
  return doc || null;
};

/**
 * Revoke a single refresh token.
 */
refreshTokenSchema.statics.revokeToken = async function (token) {
  await this.deleteOne({ token });
};

/**
 * Revoke ALL refresh tokens for a specific user (logout from all devices).
 */
refreshTokenSchema.statics.revokeAllForUser = async function (userId, userType) {
  await this.deleteMany({ userId, userType });
};

export const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);
