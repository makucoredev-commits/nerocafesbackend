import mongoose from 'mongoose';

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true, index: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    orderCount: { type: Number, default: 0 },
    countryCode: { type: String, default: '91' },
    address: { type: String, default: '' },
    notes: { type: String, default: '' },
    birthday: { type: Date, default: null },
    favouriteItems: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' }],
    // New fields for enhanced customer management
    status: { type: String, enum: ['active', 'inactive', 'blocked'], default: 'active' },
    rewardPoints: { type: Number, default: 0 },
    tags: [{ type: String, trim: true }],
    profileImage: { type: String, default: '' },
    lastLoginDate: { type: Date, default: null },
    totalSpending: { type: Number, default: 0 },
  },
  { timestamps: true }
);

customerSchema.index({ name: 'text', phone: 'text', email: 'text' });
customerSchema.index({ status: 1 });
customerSchema.index({ tags: 1 });

export const Customer = mongoose.model('Customer', customerSchema);
