import mongoose from 'mongoose';

const pushSubscriptionSchema = new mongoose.Schema(
  {
    endpoint: {
      type: String,
      required: true,
      unique: true,
    },
    auth: String,
    p256dh: String,
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    isAdmin: {
      type: Boolean,
      default: false,
    },
    userAgent: String,
    lastActive: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// TTL index: auto-remove subscriptions after 30 days of inactivity
pushSubscriptionSchema.index({ lastActive: 1 }, { expireAfterSeconds: 2592000 });
pushSubscriptionSchema.index({ userId: 1 });
pushSubscriptionSchema.index({ isAdmin: 1 });

export default mongoose.model('PushSubscription', pushSubscriptionSchema);
