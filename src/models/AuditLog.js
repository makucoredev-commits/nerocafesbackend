import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
  action: {
    type: String,
    required: true,
  },
  actorName: {
    type: String,
    default: '',
  },
  target: {
    type: String,
    default: '',
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'userTypeModel',
    default: null,
  },
  userTypeModel: {
    type: String,
    enum: ['User', 'Admin'],
    default: 'User',
  },
  userType: {
    type: String,
    enum: ['user', 'admin', 'system', 'operator'],
    default: 'system',
  },
  ip: {
    type: String,
    default: 'unknown',
  },
  userAgent: {
    type: String,
    default: 'unknown',
  },
  method: {
    type: String,
    default: '',
  },
  path: {
    type: String,
    default: '',
  },
  body: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  query: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  status: {
    type: Number,
    default: null,
  },
  success: {
    type: Boolean,
    default: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

// Index for faster queries
auditLogSchema.index({ timestamp: -1 });
auditLogSchema.index({ userId: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ userType: 1, timestamp: -1 });

// TTL: Keep logs for 90 days
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
export default AuditLog;
