import mongoose from 'mongoose';

const emailVerificationTokenSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    token: { type: String, required: true, unique: true },
    purpose: { type: String, enum: ['activation', 'password-reset', 'email-change'], default: 'activation', index: true },
    expiresAt: { type: Date, required: true },
    used: { type: Boolean, default: false },
    invalidatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

emailVerificationTokenSchema.index({ email: 1 });
emailVerificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailVerificationToken = mongoose.model('EmailVerificationToken', emailVerificationTokenSchema);
