import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const trustedDeviceSchema = new mongoose.Schema(
  {
    fingerprint: { type: String, required: true },
    label: { type: String, default: 'Unknown Browser' },
    lastUsed: { type: Date, default: Date.now },
    ip: { type: String, default: '' },
  },
  { _id: false }
);

const adminSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 8 },
    trustedDevices: { type: [trustedDeviceSchema], default: [] },
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

adminSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

adminSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

adminSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

export const Admin = mongoose.model('Admin', adminSchema);
