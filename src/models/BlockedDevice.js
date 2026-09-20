import mongoose from 'mongoose';

const blockedDeviceSchema = new mongoose.Schema(
  {
    target: { type: String, required: true, index: true }, // IP, fingerprint, sessionId, phone, or userId
    type: { type: String, enum: ['IP', 'FINGERPRINT', 'SESSION', 'PHONE', 'USER'], default: 'IP' },
    label: { type: String, default: 'Blocked Device' },
    ip: { type: String, default: '' },
    phone: { type: String, default: '' },
    fingerprint: { type: String, default: '' },
    deviceModel: { type: String, default: 'Unknown Device' },
    browser: { type: String, default: '' },
    os: { type: String, default: '' },
    city: { type: String, default: '' },
    region: { type: String, default: '' },
    country: { type: String, default: '' },
    locationLabel: { type: String, default: '' },
    reason: { type: String, default: 'Blocked by administrator' },
    blockedBy: { type: String, default: 'Admin Terminal' },
    isActive: { type: Boolean, default: true, index: true },
    blockedAt: { type: Date, default: Date.now },
    unblockedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const BlockedDevice = mongoose.model('BlockedDevice', blockedDeviceSchema);
export default BlockedDevice;
