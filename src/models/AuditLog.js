import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
  action: {
    type: String,
    required: true,
    enum: [
      'LOGIN',
      'LOGOUT',
      'ORDER_CREATE',
      'ORDER_UPDATE',
      'ORDER_CANCEL',
      'MENU_UPDATE',
      'ADMIN_CREATE',
      'ADMIN_UPDATE',
      'ADMIN_DELETE',
      'SETTINGS_UPDATE',
      'PAYMENT_PROCESS',
      'REFUND_PROCESS',
      'USER_UPDATE',
      'PASSWORD_CHANGE',
      'API_ACCESS',
      'CUSTOMER_VIBRATION',
    ],
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  userType: {
    type: String,
    enum: ['user', 'admin', 'system'],
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
