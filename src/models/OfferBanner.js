import mongoose from 'mongoose';

const offerBannerSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const OfferBanner = mongoose.model('OfferBanner', offerBannerSchema);
