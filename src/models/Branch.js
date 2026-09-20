import mongoose from 'mongoose';

const branchSchema = new mongoose.Schema(
  {
    branchId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    branchCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    displayName: {
      type: String,
      default: '',
      trim: true,
    },
    address: {
      type: String,
      default: '',
      trim: true,
    },
    city: {
      type: String,
      default: 'Hyderabad',
      trim: true,
    },
    state: {
      type: String,
      default: 'Telangana',
      trim: true,
    },
    country: {
      type: String,
      default: 'India',
      trim: true,
    },
    latitude: {
      type: Number,
      required: true,
    },
    longitude: {
      type: Number,
      required: true,
    },
    serviceRadius: {
      type: Number,
      default: 5000, // In meters (5 km)
    },
    timezone: {
      type: String,
      default: 'Asia/Kolkata',
      trim: true,
    },
    phone: {
      type: String,
      default: '',
      trim: true,
    },
    email: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },
    openingHours: {
      open: { type: String, default: '10:00' },
      close: { type: String, default: '22:00' },
      days: { type: [String], default: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] },
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE', 'MAINTENANCE'],
      default: 'ACTIVE',
      index: true,
    },
    databaseIdentifier: {
      type: String,
      required: true,
      trim: true,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

branchSchema.index({ latitude: 1, longitude: 1 });

export const Branch = mongoose.model('Branch', branchSchema);
