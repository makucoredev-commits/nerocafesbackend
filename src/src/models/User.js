import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { getGravatarUrl } from '../utils/gravatar.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true, trim: true },
    avatarUrl: { type: String, default: '', trim: true },
    password: { type: String, required: true, minlength: 6 },
    mustChangePassword: { type: Boolean, default: false },
    address: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  const gravatarUrl = getGravatarUrl(obj.email);
  const custom = (obj.avatarUrl || '').trim();
  return {
    ...obj,
    gravatarUrl,
    /** Prefer uploaded image path (/uploads/...); otherwise Gravatar from email */
    avatarDisplayUrl: custom || gravatarUrl,
  };
};

export const User = mongoose.model('User', userSchema);
