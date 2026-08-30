import mongoose from 'mongoose';

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    type: {
      type: String,
      enum: ['flat', 'percentage', 'product', 'category', 'buy_x_get_y', 'flash_sale', 'happy_hour'],
      required: true
    },
    value: { type: Number, required: true }, // For flat: amount, percentage: %, product: product ID
    minValue: { type: Number, default: 0 }, // Minimum order value
    maxValue: { type: Number, default: null }, // Maximum discount amount
    category: { type: String, default: '' }, // For category-based coupons
    buyQuantity: { type: Number, default: 0 }, // For buy X get Y
    getQuantity: { type: Number, default: 0 }, // For buy X get Y
    getProductIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' }], // Products to get free
    applicableProductIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' }], // Products coupon applies to
    usageLimit: { type: Number, default: null }, // Total usage limit
    usagePerCustomer: { type: Number, default: 1 }, // Per customer limit
    usedCount: { type: Number, default: 0 },
    customerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // Customer-specific coupons
    startTime: { type: Date, default: null }, // For scheduled coupons
    endTime: { type: Date, default: null }, // For scheduled coupons
    isActive: { type: Boolean, default: true },
    autoApply: { type: Boolean, default: false },
    priority: { type: Number, default: 0 }, // Higher priority applied first
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

couponSchema.index({ isActive: 1, startTime: 1, endTime: 1 });

export const Coupon = mongoose.model('Coupon', couponSchema);
