import mongoose from 'mongoose';

/** Singleton-style settings document (first row wins). */
const shopSettingsSchema = new mongoose.Schema(
  {
    shopOpen: { type: Boolean, default: true },
    closedMessage: {
      type: String,
      default: 'The cafe is closed. Try again tomorrow.',
      trim: true,
    },
    /** Featured item on the homepage hero card (optional; falls back to a Featured-tagged item). */
    heroMenuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', default: null },
    heroCardLabel: { type: String, default: "Tonight's pick", trim: true },
    /** Shop's contact phone number for WhatsApp */
    contactPhoneNumber: { type: String, default: '919100020345', trim: true },
    /** Auto Open/Close Settings */
    autoOpenTime: { type: String, default: '10:00' }, // HH:MM format
    autoCloseTime: { type: String, default: '22:00' },
    /** Holiday Mode */
    holidayMode: { type: Boolean, default: false },
    holidayMessage: { type: String, default: 'We are on holiday. Will be back soon!' },
    /** Maintenance Mode */
    maintenanceMode: { type: Boolean, default: false },
    maintenanceMessage: { type: String, default: 'System under maintenance. Please check back later.' },
    /** ETA Threshold */
    etaThresholdMinutes: { type: Number, default: 25 },
    /** Active Chefs */
    activeChefIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }],
    /** GST Settings */
    gstEnabled: { type: Boolean, default: true },
    gstRate: { type: Number, default: 5 }, // Percentage
    /** Delivery Fee */
    deliveryFee: { type: Number, default: 0 },
    freeDeliveryAbove: { type: Number, default: 0 },
    /** Email Settings */
    emailEnabled: { type: Boolean, default: true },
    smtpHost: { type: String, default: '' },
    smtpPort: { type: Number, default: 587 },
    smtpUser: { type: String, default: '' },
    /** WhatsApp Settings */
    whatsappEnabled: { type: Boolean, default: true },
    whatsappApiKey: { type: String, default: '' },
    /** Inventory Settings */
    autoOutOfStock: { type: Boolean, default: false },
    /** Theme & Banding */
    primaryColor: { type: String, default: '#c9a962' },
    secondaryColor: { type: String, default: '#05204A' },
    logoUrl: { type: String, default: '' },
    shopName: { type: String, default: 'NeroCafes' },
  },
  { timestamps: true }
);

export const ShopSettings = mongoose.model('ShopSettings', shopSettingsSchema);

export async function getOrCreateShopSettings() {
  let s = await ShopSettings.findOne();
  if (!s) s = await ShopSettings.create({});
  return s;
}
