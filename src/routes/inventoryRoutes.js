import { Router } from 'express';
import { InventoryItem, StockMovement, PurchaseOrder, Supplier, WasteRecord } from '../models/Inventory.js';
import { MenuItem } from '../models/MenuItem.js';
import { authAdmin } from '../middleware/authAdmin.js';
import { broadcastInventoryStockChange } from '../utils/inventoryBroadcast.js';

const router = Router();

/* ── Inventory Items ───────────────────────────────────────────── */

/**
 * GET /admin/inventory
 * Get all inventory items
 */
router.get('/', authAdmin, async (req, res) => {
  try {
    const items = await InventoryItem.find({ isActive: true }).sort({ category: 1, name: 1 });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/inventory
 * Create inventory item
 */
router.post('/', authAdmin, async (req, res) => {
  try {
    const item = await InventoryItem.create(req.body);
    res.status(201).json({ item });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * PUT /admin/inventory/:id
 * Update inventory item
 */
router.put('/:id', authAdmin, async (req, res) => {
  try {
    const item = await InventoryItem.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ item });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * DELETE /admin/inventory/:id
 * Soft delete inventory item
 */
router.delete('/:id', authAdmin, async (req, res) => {
  try {
    const item = await InventoryItem.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ item });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ── Stock Movements ─────────────────────────────────────────────── */

/**
 * GET /admin/inventory/movements
 * Get stock movement history
 */
router.get('/movements', authAdmin, async (req, res) => {
  try {
    const movements = await StockMovement.find()
      .populate('inventoryItemId', 'name sku')
      .populate('performedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(100);
    res.json({ movements });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/inventory/adjust
 * Adjust stock level
 */
router.post('/adjust', authAdmin, async (req, res) => {
  try {
    const { inventoryItemId, quantity, type, reason, referenceId } = req.body;
    
    const item = await InventoryItem.findById(inventoryItemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    
    const previousStock = item.currentStock;
    const newStock = previousStock + quantity;
    
    if (newStock < 0) {
      return res.status(400).json({ error: 'Insufficient stock for this adjustment' });
    }
    
    item.currentStock = newStock;
    await item.save();
    
    const movement = await StockMovement.create({
      inventoryItemId,
      type: type || 'adjustment',
      quantity,
      previousStock,
      newStock,
      reason: reason || 'Manual adjustment',
      referenceId: referenceId || '',
      performedBy: req.admin?._id
    });
    
    const io = req.app.get('io');
    await broadcastInventoryStockChange(io, inventoryItemId);
    
    res.json({ item, movement });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ── Purchase Orders ─────────────────────────────────────────────── */

/**
 * GET /admin/inventory/purchase-orders
 * Get all purchase orders
 */
router.get('/purchase-orders', authAdmin, async (req, res) => {
  try {
    const orders = await PurchaseOrder.find().sort({ orderDate: -1 });
    res.json({ orders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/inventory/purchase-orders
 * Create purchase order
 */
router.post('/purchase-orders', authAdmin, async (req, res) => {
  try {
    const lastOrder = await PurchaseOrder.findOne().sort({ orderNumber: -1 });
    const orderNumber = lastOrder ? `PO-${String(parseInt(lastOrder.orderNumber.split('-')[1]) + 1).padStart(4, '0')}` : 'PO-0001';
    
    const order = await PurchaseOrder.create({
      ...req.body,
      orderNumber
    });
    
    res.status(201).json({ order });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * PUT /admin/inventory/purchase-orders/:id/receive
 * Receive purchase order and update stock
 */
router.put('/purchase-orders/:id/receive', authAdmin, async (req, res) => {
  try {
    const order = await PurchaseOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'Received') return res.status(400).json({ error: 'Order already received' });
    
    // Update stock for each item
    for (const item of order.items) {
      const inventoryItem = await InventoryItem.findById(item.inventoryItemId);
      if (inventoryItem) {
        const previousStock = inventoryItem.currentStock;
        const newStock = previousStock + item.quantity;
        
        inventoryItem.currentStock = newStock;
        await inventoryItem.save();
        
        await StockMovement.create({
          inventoryItemId: item.inventoryItemId,
          type: 'purchase',
          quantity: item.quantity,
          previousStock,
          newStock,
          reason: `Purchase Order ${order.orderNumber}`,
          referenceId: order._id.toString(),
          performedBy: req.admin?._id
        });
        
        const io = req.app.get('io');
        await broadcastInventoryStockChange(io, item.inventoryItemId);
      }
    }
    
    order.status = 'Received';
    order.receivedDate = new Date();
    await order.save();
    
    res.json({ order });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ── Stock Alerts ───────────────────────────────────────────────── */

/**
 * GET /admin/inventory/alerts
 * Get low/critical stock alerts
 */
router.get('/alerts', authAdmin, async (req, res) => {
  try {
    const lowStockItems = await InventoryItem.find({
      isActive: true,
      $expr: { $lte: ['$currentStock', '$minStockLevel'] }
    });
    
    const criticalStockItems = await InventoryItem.find({
      isActive: true,
      $expr: { $lte: ['$currentStock', { $multiply: ['$minStockLevel', 0.5] }] }
    });
    
    const expiringItems = await InventoryItem.find({
      isActive: true,
      expiryDate: { $lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } // Expiring within 7 days
    });
    
    res.json({
      lowStock: lowStockItems,
      criticalStock: criticalStockItems,
      expiring: expiringItems
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Menu Item Inventory Check ──────────────────────────────────── */

/**
 * POST /admin/inventory/check-menu-item
 * Check if menu item can be made with current stock
 */
router.post('/check-menu-item', authAdmin, async (req, res) => {
  try {
    const { menuItemId } = req.body;

    const menuItem = await MenuItem.findById(menuItemId).populate('ingredients.inventoryItemId');
    if (!menuItem) return res.status(404).json({ error: 'Menu item not found' });

    const canMake = [];
    const cannotMake = [];
    let totalCost = 0;

    for (const ingredient of menuItem.ingredients || []) {
      const inventoryItem = ingredient.inventoryItemId;
      if (!inventoryItem) continue;

      const servingsPossible = Math.floor(inventoryItem.currentStock / ingredient.quantity);
      const costPerServing = ingredient.quantity * inventoryItem.costPerUnit;
      totalCost += costPerServing;

      const status = servingsPossible > 0 ? 'Healthy' :
                     servingsPossible === 0 ? 'Critical' : 'Low';

      const check = {
        name: ingredient.name,
        requiredQuantity: ingredient.quantity,
        unit: ingredient.unit,
        currentStock: inventoryItem.currentStock,
        status,
        servingsPossible,
        costPerServing
      };

      if (servingsPossible > 0) {
        canMake.push(check);
      } else {
        cannotMake.push(check);
      }
    }

    const profitMargin = menuItem.price - menuItem.costPrice - totalCost;
    const profitPercentage = menuItem.price > 0 ? ((profitMargin / menuItem.price) * 100).toFixed(2) : 0;

    res.json({
      menuItem: menuItem.name,
      canMake,
      cannotMake,
      canBeSold: cannotMake.length === 0,
      totalIngredientCost: totalCost,
      profitMargin,
      profitPercentage
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ── Suppliers ─────────────────────────────────────────────────── */

/**
 * GET /admin/inventory/suppliers
 * Get all suppliers
 */
router.get('/suppliers', authAdmin, async (req, res) => {
  try {
    const suppliers = await Supplier.find({ isActive: true }).sort({ name: 1 });
    res.json({ suppliers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/inventory/suppliers
 * Create supplier
 */
router.post('/suppliers', authAdmin, async (req, res) => {
  try {
    const supplier = await Supplier.create(req.body);
    res.status(201).json({ supplier });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * PUT /admin/inventory/suppliers/:id
 * Update supplier
 */
router.put('/suppliers/:id', authAdmin, async (req, res) => {
  try {
    const supplier = await Supplier.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    res.json({ supplier });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * DELETE /admin/inventory/suppliers/:id
 * Soft delete supplier
 */
router.delete('/suppliers/:id', authAdmin, async (req, res) => {
  try {
    const supplier = await Supplier.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    res.json({ supplier });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ── Waste Records ──────────────────────────────────────────────── */

/**
 * GET /admin/inventory/waste
 * Get all waste records
 */
router.get('/waste', authAdmin, async (req, res) => {
  try {
    const waste = await WasteRecord.find()
      .populate('inventoryItemId', 'name sku')
      .populate('performedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(100);
    res.json({ waste });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/inventory/waste
 * Record waste
 */
router.post('/waste', authAdmin, async (req, res) => {
  try {
    const { inventoryItemId, quantity, reason } = req.body;

    const item = await InventoryItem.findById(inventoryItemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const previousStock = item.currentStock;
    const newStock = previousStock - quantity;

    if (newStock < 0) {
      return res.status(400).json({ error: 'Insufficient stock for waste record' });
    }

    item.currentStock = newStock;
    await item.save();

    const cost = quantity * item.costPerUnit;

    const waste = await WasteRecord.create({
      inventoryItemId,
      quantity,
      reason,
      cost,
      performedBy: req.admin?._id
    });

    // Also create a stock movement record
    await StockMovement.create({
      inventoryItemId,
      type: 'waste',
      quantity: -quantity,
      previousStock,
      newStock,
      reason: `Waste: ${reason}`,
      performedBy: req.admin?._id
    });

    const io = req.app.get('io');
    await broadcastInventoryStockChange(io, inventoryItemId);

    res.json({ waste, item });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
