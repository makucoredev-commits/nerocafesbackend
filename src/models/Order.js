import mongoose from 'mongoose';

const ORDER_STATUS = [
  'Received',
  'Confirmed',
  'Queued',
  'Preparing',
  'Cooking',
  'Packing',
  'Ready',
  'Completed',
  'Cancelled'
];

const orderItemSchema = new mongoose.Schema(
  {
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
    name: String,
    image: { type: String, default: '' },
    price: Number,
    category: { type: String, default: '' },
    dietaryCategory: { type: String, enum: ['Veg', 'Non-Veg', 'Egg', 'Unknown'], default: 'Unknown' },
    quantity: { type: Number, required: true, min: 1 },
    preparationTime: { type: Number, default: 0 }, // in minutes
    bufferTime: { type: Number, default: 0 }, // in minutes
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderNo: { type: Number, required: true, unique: true, sparse: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    trackingToken: { type: String, required: true, unique: true },
    items: [orderItemSchema],
    totalPrice: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ORDER_STATUS, default: 'Received' },
    priority: { type: String, enum: ['normal', 'high', 'urgent'], default: 'normal' },
    customer: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      email: { type: String, default: '' },
    },
    paymentMethod: { type: String, default: 'COD' },
    paymentStatus: { type: String, enum: ['Pending', 'Completed', 'Failed', 'Refunded', 'Cash Pending'], default: 'Pending' },
    paymentMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
    isOutOfRange: { type: Boolean, default: false },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, default: '' },
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      mapLink: { type: String, default: '' },
    },
    notes: { type: String, default: '' },
    /* ── ETA & Kitchen Queue ──────────────────────────────────── */
    estimatedPrepTime: { type: Number, default: 0 }, // in minutes
    estimatedReadyTime: { type: Date, default: null },
    remainingTime: { type: Number, default: 0 }, // in minutes
    chefAssigned: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    queuePosition: { type: Number, default: 0 },
    preparationStartedAt: { type: Date, default: null },
    cookingStartedAt: { type: Date, default: null },
    packingStartedAt: { type: Date, default: null },
    readyAt: { type: Date, default: null },
    etaRecalculatedAt: { type: Date, default: null },
    longEtaAcknowledged: { type: Boolean, default: false },
  },
  { timestamps: true }
);

orderSchema.index({ userId: 1, status: 1 });
orderSchema.index({ 'customer.phone': 1, cancelledAt: 1 });
orderSchema.index({ status: 1, estimatedReadyTime: 1 });
orderSchema.index({ chefAssigned: 1, status: 1 });

export const ORDER_STATUSES = ORDER_STATUS;
export const Order = mongoose.model('Order', orderSchema);
