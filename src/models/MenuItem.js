import mongoose from 'mongoose';

const TAGS = ['New', 'Featured', 'Combo', 'Trending', 'Ultimate Combo'];
const DIETARY_CATEGORIES = ['Veg', 'Non-Veg', 'Egg'];

const menuItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    costPrice: { type: Number, default: 0 },
    category: {
      type: String,
      required: true,
      enum: ['Burgers', 'Sandwiches', 'Maggie', 'Fries', 'Drinks', 'Pizza', 'Combos', 'Add-ons', 'Desserts', 'Breakfast'],
    },
    subcategory: { type: String, default: '' },
    tags: [{ type: String, enum: TAGS }],
    available: { type: Boolean, default: true },
    autoInventory: { type: Boolean, default: false },
    image: { type: String, default: '' },
    description: { type: String, default: '' },
    orderCount: { type: Number, default: 0 },
    dietaryCategory: {
      type: String,
      enum: [...DIETARY_CATEGORIES, 'Unknown'],
      default: 'Unknown',
    },
    preparationTime: { type: Number, default: 10 }, // in minutes
    bufferTime: { type: Number, default: 2 }, // in minutes (buffer for unexpected delays)
    // Inventory & Ingredients
    ingredients: [{
      inventoryItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem' },
      name: { type: String, required: true },
      quantity: { type: Number, required: true }, // Quantity per serving
      unit: { type: String, required: true }
    }],
    // Variants
    variants: [{
      name: { type: String, required: true },
      price: { type: Number, required: true },
      costPrice: { type: Number, default: 0 },
      available: { type: Boolean, default: true }
    }],
    // Add-ons
    addOns: [{
      menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
      name: { type: String, required: true },
      price: { type: Number, required: true }
    }],
    // Flags
    isBestSeller: { type: Boolean, default: false },
    isRecommended: { type: Boolean, default: false },
    isSeasonal: { type: Boolean, default: false },
    // New Item Popup Settings
    showAsNew: { type: Boolean, default: false },
    dateAdded: { type: Date, default: Date.now },
    popupPriority: { type: Number, default: 0 }, // Higher = shown first
    popupImage: { type: String, default: '' },
    popupDescription: { type: String, default: '' },
    // Nutritional Info (placeholder)
    nutritionalInfo: {
      calories: { type: Number, default: 0 },
      protein: { type: Number, default: 0 },
      carbs: { type: Number, default: 0 },
      fat: { type: Number, default: 0 }
    },
    // GST
    gstRate: { type: Number, default: 5 }, // Percentage
  },
  { timestamps: true }
);

export const MENU_TAGS = TAGS;
export const MenuItem = mongoose.model('MenuItem', menuItemSchema);
