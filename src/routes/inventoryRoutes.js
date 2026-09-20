import { Router } from 'express';
import { authAdmin } from '../middleware/authAdmin.js';
import { resolveBranchContext, requireBranchAccess } from '../middleware/branchContext.js';
import { broadcastInventoryStockChange } from '../utils/inventoryBroadcast.js';
import { logger } from '../utils/logger.js';

const router = Router();

// All inventory routes are branch-isolated:
// Each branch has its own separate inventory database.
const branchMiddleware = [authAdmin, resolveBranchContext, requireBranchAccess];

/* ── Inventory Items ───────────────────────────────────────────── */

/**
 * GET /admin/inventory
 * Get all inventory items for the current branch
 */
router.get('/', ...branchMiddleware, async (req, res) => {
  try {
    const InventoryItem = await req.getBranchModel('InventoryItem');
    const items = await InventoryItem.find({ isActive: true }).sort({ category: 1, name: 1 });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/inventory
 * Create inventory item in the current branch
 */
router.post('/', ...branchMiddleware, async (req, res) => {
  try {
    const InventoryItem = await req.getBranchModel('InventoryItem');
    const item = await InventoryItem.create(req.body);
    res.status(201).json({ item });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * PUT /admin/inventory/:id
 * Update inventory item in the current branch
 */
router.put('/:id', ...branchMiddleware, async (req, res) => {
  try {
    const InventoryItem = await req.getBranchModel('InventoryItem');
    const item = await InventoryItem.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ item });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * DELETE /admin/inventory/:id
 * Soft delete inventory item in the current branch
 */
router.delete('/:id', ...branchMiddleware, async (req, res) => {
  try {
    const InventoryItem = await req.getBranchModel('InventoryItem');
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
 * Get stock movement history for the current branch
 */
router.get('/movements', ...branchMiddleware, async (req, res) => {
  try {
    const StockMovement = await req.getBranchModel('StockMovement');
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
 * Adjust stock level in the current branch
 */
router.post('/adjust', ...branchMiddleware, async (req, res) => {
  try {
    const { inventoryItemId, quantity, type, reason, referenceId } = req.body;

    // Validate required fields
    if (!inventoryItemId) {
      return res.status(400).json({ error: 'inventoryItemId is required' });
    }
    if (quantity === undefined || quantity === null) {
      return res.status(400).json({ error: 'quantity is required' });
    }

    // Convert to numbers
    const qty = Number(quantity);
    if (isNaN(qty)) {
      return res.status(400).json({ error: 'quantity must be a number' });
    }

    const InventoryItem = await req.getBranchModel('InventoryItem');
    const StockMovement = await req.getBranchModel('StockMovement');

    const item = await InventoryItem.findById(inventoryItemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const previousStock = Number(item.currentStock) || 0;
    const newStock = previousStock + qty;

    if (newStock < 0) {
      return res.status(400).json({ error: 'Insufficient stock for this adjustment' });
    }

    item.currentStock = newStock;
    await item.save();

    const movement = await StockMovement.create({
      inventoryItemId,
      type: type || 'adjustment',
      quantity: qty,
      previousStock,
      newStock,
      reason: reason || 'Manual adjustment',
      referenceId: referenceId || '',
      performedBy: req.admin?._id
    });

    const io = req.app.get('io');
    await broadcastInventoryStockChange(io, inventoryItemId, req.branchId);

    res.json({ item, movement });
  } catch (e) {
    logger.error('INVENTORY', `Inventory adjustment error: ${e.message}`, { error: e });
    res.status(400).json({ error: e.message });
  }
});

/* ── Purchase Orders ─────────────────────────────────────────────── */

/**
 * GET /admin/inventory/purchase-orders
 * Get all purchase orders for the current branch
 */
router.get('/purchase-orders', ...branchMiddleware, async (req, res) => {
  try {
    const PurchaseOrder = await req.getBranchModel('PurchaseOrder');
    const orders = await PurchaseOrder.find().sort({ orderDate: -1 });
    res.json({ orders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/inventory/purchase-orders
 * Create purchase order in the current branch
 */
router.post('/purchase-orders', ...branchMiddleware, async (req, res) => {
  try {
    const PurchaseOrder = await req.getBranchModel('PurchaseOrder');
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
 * Receive purchase order and update stock in the current branch
 */
router.put('/purchase-orders/:id/receive', ...branchMiddleware, async (req, res) => {
  try {
    const PurchaseOrder = await req.getBranchModel('PurchaseOrder');
    const InventoryItem = await req.getBranchModel('InventoryItem');
    const StockMovement = await req.getBranchModel('StockMovement');

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
        await broadcastInventoryStockChange(io, item.inventoryItemId, req.branchId);
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
 * Get low/critical stock alerts for the current branch
 */
router.get('/alerts', ...branchMiddleware, async (req, res) => {
  try {
    const InventoryItem = await req.getBranchModel('InventoryItem');

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
 * Check if menu item can be made with current stock (branch-scoped)
 */
router.post('/check-menu-item', ...branchMiddleware, async (req, res) => {
  try {
    const { menuItemId } = req.body;

    const MenuItem = await req.getBranchModel('MenuItem');
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
 * Get all suppliers for the current branch
 */
router.get('/suppliers', ...branchMiddleware, async (req, res) => {
  try {
    const Supplier = await req.getBranchModel('Supplier');
    const suppliers = await Supplier.find({ isActive: true }).sort({ name: 1 });
    res.json({ suppliers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/inventory/suppliers
 * Create supplier in the current branch
 */
router.post('/suppliers', ...branchMiddleware, async (req, res) => {
  try {
    const Supplier = await req.getBranchModel('Supplier');
    const supplier = await Supplier.create(req.body);
    res.status(201).json({ supplier });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * PUT /admin/inventory/suppliers/:id
 * Update supplier in the current branch
 */
router.put('/suppliers/:id', ...branchMiddleware, async (req, res) => {
  try {
    const Supplier = await req.getBranchModel('Supplier');
    const supplier = await Supplier.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    res.json({ supplier });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * DELETE /admin/inventory/suppliers/:id
 * Soft delete supplier in the current branch
 */
router.delete('/suppliers/:id', ...branchMiddleware, async (req, res) => {
  try {
    const Supplier = await req.getBranchModel('Supplier');
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
 * Get all waste records for the current branch
 */
router.get('/waste', ...branchMiddleware, async (req, res) => {
  try {
    const WasteRecord = await req.getBranchModel('WasteRecord');
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
 * Record waste in the current branch
 */
router.post('/waste', ...branchMiddleware, async (req, res) => {
  try {
    const { inventoryItemId, quantity, reason } = req.body;

    const InventoryItem = await req.getBranchModel('InventoryItem');
    const StockMovement = await req.getBranchModel('StockMovement');
    const WasteRecord = await req.getBranchModel('WasteRecord');

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
    await broadcastInventoryStockChange(io, inventoryItemId, req.branchId);

    res.json({ waste, item });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
