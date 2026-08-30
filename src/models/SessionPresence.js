import mongoose from 'mongoose';

const sessionPresenceSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    userType: { type: String, enum: ['CUSTOMER', 'ADMIN'], required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, refPath: 'userRefModel', default: null },
    userRefModel: { type: String, enum: ['User', 'Admin'], default: 'User' },
    userLabel: { type: String, default: 'Anonymous Guest' },
    deviceCategory: { type: String, enum: ['mobile', 'desktop', 'tablet', 'unknown'], default: 'desktop' },
    deviceModel: { type: String, default: 'Generic Device' },
    browser: { type: String, default: 'Unknown Browser' },
    browserVersion: { type: String, default: '' },
    os: { type: String, default: 'Unknown OS' },
    osVersion: { type: String, default: '' },
    screenResolution: { type: String, default: '' },
    city: { type: String, default: '' },
    region: { type: String, default: '' },
    country: { type: String, default: '' },
    locationLabel: { type: String, default: 'Unknown Location' },
    ip: { type: String, default: '127.0.0.1' },
    currentPage: { type: String, default: '/' },
    sessionStartTime: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now, index: true },
    isRevoked: { type: Boolean, default: false, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// TTL: Auto-delete session documents inactive for more than 24 hours
sessionPresenceSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 86400 });

export const SessionPresence = mongoose.model('SessionPresence', sessionPresenceSchema);
export default SessionPresence;
