import mongoose from 'mongoose';

const newItemPopupSchema = new mongoose.Schema(
  {
    userId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User',
      required: true 
    },
    menuItemId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'MenuItem',
      required: true 
    },
    shown: { type: Boolean, default: false },
    dismissed: { type: Boolean, default: false },
    clicked: { type: Boolean, default: false },
    shownAt: { type: Date },
    dismissedAt: { type: Date },
    clickedAt: { type: Date },
  },
  { timestamps: true }
);

// Compound index to prevent duplicate entries
newItemPopupSchema.index({ userId: 1, menuItemId: 1 }, { unique: true });

export const NewItemPopup = mongoose.model('NewItemPopup', newItemPopupSchema);
