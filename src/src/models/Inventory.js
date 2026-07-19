import mongoose from 'mongoose';

const inventoryItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, unique: true, sparse: true },
    category: {
      type: String,
      enum: ['Ingredients', 'Beverages', 'Packaging', 'Dairy', 'Grains', 'Spices', 'Meat', 'Vegetables', 'Fruits', 'Other'],
      default: 'Other'
    },
    unit: {
      type: String,
      enum: ['kg', 'g', 'l', 'ml', 'pcs', 'dozen', 'pack', 'box'],
      default: 'pcs'
    },
    currentStock: { type: Number, required: true, default: 0 },
    minStockLevel: { type: Number, default: 10 },
    maxStockLevel: { type: Number, default: 100 },
    costPerUnit: { type: Number, required: true, default: 0 },
    supplier: { type: String, default: '' },
    supplierContact: { type: String, default: '' },
    expiryDate: { type: Date, default: null },
    batchNumber: { type: String, default: '' },
    location: { type: String, default: '' }, // Storage location
    isActive: { type: Boolean, default: true },
    notes: { type: String, default: '' }
  },
  { timestamps: true }
);

const stockMovementSchema = new mongoose.Schema(
  {
    inventoryItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
    type: {
      type: String,
      enum: ['purchase', 'sale', 'adjustment', 'restock', 'waste', 'refund', 'return', 'manual', 'order', 'cancelled', 'transfer'],
      required: true
    },
    quantity: { type: Number, required: true },
    previousStock: { type: Number, required: true },
    newStock: { type: Number, required: true },
    reason: { type: String, default: '' },
    referenceId: { type: String, default: '' }, // Order ID, Purchase Order ID, etc.
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null }
  },
  { timestamps: true }
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    supplier: { type: String, required: true },
    supplierContact: { type: String, default: '' },
    items: [{
      inventoryItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
      name: { type: String, required: true },
      quantity: { type: Number, required: true },
      unit: { type: String, required: true },
      costPerUnit: { type: Number, required: true },
      totalCost: { type: Number, required: true }
    }],
    totalAmount: { type: Number, required: true },
    status: {
      type: String,
      enum: ['Pending', 'Ordered', 'Received', 'Cancelled'],
      default: 'Pending'
    },
    orderDate: { type: Date, default: Date.now },
    expectedDeliveryDate: { type: Date, default: null },
    receivedDate: { type: Date, default: null },
    notes: { type: String, default: '' }
  },
  { timestamps: true }
);

const supplierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    contact: { type: String, default: '' },
    email: { type: String, default: '' },
    address: { type: String, default: '' },
    rating: { type: Number, default: 5, min: 1, max: 5 },
    notes: { type: String, default: '' },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

const wasteRecordSchema = new mongoose.Schema(
  {
    inventoryItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
    quantity: { type: Number, required: true },
    reason: { type: String, required: true },
    cost: { type: Number, required: true },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null }
  },
  { timestamps: true }
);

export const InventoryItem = mongoose.model('InventoryItem', inventoryItemSchema);
export const StockMovement = mongoose.model('StockMovement', stockMovementSchema);
export const PurchaseOrder = mongoose.model('PurchaseOrder', purchaseOrderSchema);
export const Supplier = mongoose.model('Supplier', supplierSchema);
export const WasteRecord = mongoose.model('WasteRecord', wasteRecordSchema);
