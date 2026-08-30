import mongoose from 'mongoose';

const whatsappTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    messageType: { 
      type: String, 
      enum: ['confirmation', 'ready', 'cancellation', 'custom'], 
      default: 'custom' 
    },
    messageBody: { type: String, required: true },
    variables: [{ type: String }], // e.g., ['orderNo', 'customerName', 'totalPrice']
    enabled: { type: Boolean, default: true },
    isApproved: { type: Boolean, default: false }, // Meta approved status
    metaStatus: { type: String, default: 'pending' }, // 'pending', 'approved', 'rejected'
    dropboxId: { type: String, default: '' }, // Reference to Dropbox file ID
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    usageCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const WhatsAppTemplate = mongoose.model('WhatsAppTemplate', whatsappTemplateSchema);
