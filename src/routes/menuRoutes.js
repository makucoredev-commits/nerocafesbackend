import { Router } from 'express';
import { MenuItem } from '../models/MenuItem.js';
import { Order } from '../models/Order.js';
import { NewItemPopup } from '../models/NewItemPopup.js';
import { authAdmin } from '../middleware/authAdmin.js';
import { authUser, requireUser } from '../middleware/authUser.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { getMenuItemMaxQuantity } from '../utils/inventoryBroadcast.js';
import { normalizeMenuItem, normalizeMenuItems } from '../utils/normalizeMenuItem.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

const isIngredientStockAvailable = (menuItem, settings) => {
  if (!menuItem || menuItem.available === false) return false;
  if (!settings?.autoOutOfStock || menuItem.autoInventory !== true) return true;

  const ingredients = Array.isArray(menuItem.ingredients) ? menuItem.ingredients : [];
  if (ingredients.length === 0) return true;

  for (const ingredient of ingredients) {
    const inventoryItem = ingredient?.inventoryItemId;
    if (!inventoryItem || inventoryItem.isActive === false) continue;

    const currentStock = Number(inventoryItem.currentStock || 0);
    const requiredQuantity = Number(ingredient.quantity || 0);

    if (currentStock < requiredQuantity) {
      return false;
    }
  }

  return true;
};

/* ── Menu image upload config ─────────────────────────────────── */
const MENU_UPLOAD_DIR = path.join(__dirname, '../../uploads/menu');
if (!fs.existsSync(MENU_UPLOAD_DIR)) fs.mkdirSync(MENU_UPLOAD_DIR, { recursive: true });

const menuStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MENU_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `menu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});

const menuUpload = multer({
  storage: menuStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|gif/;
    const ok = allowed.test(file.mimetype) && allowed.test(path.extname(file.originalname).toLowerCase().replace('.', ''));
    cb(ok ? null : new Error('Only image files are allowed'), ok);
  },
});

/* ── Public menu routes ───────────────────────────────────────── */

router.get('/stock/:menuItemId', async (req, res) => {
  try {
    const item = await MenuItem.findById(req.params.menuItemId)
      .populate('ingredients.inventoryItemId');
    if (!item) return res.status(404).json({ error: 'Menu item not found' });
    const maxQty = await getMenuItemMaxQuantity(item);
    res.json({
      menuItemId: item._id.toString(),
      maxQuantity: maxQty,
      outOfStock: maxQty <= 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { category, search, page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(10, parseInt(limit) || 50));
    const skip = (pageNum - 1) * limitNum;
    const { ShopSettings } = await import('../models/ShopSettings.js');
    const settings = await ShopSettings.findOne();

    const q = { available: true };
    if (category) q.category = String(category).trim();
    if (search) {
      const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      q.$or = [
        { name: new RegExp(escaped, 'i') },
        { category: new RegExp(escaped, 'i') },
      ];
    }

    const projection = {
      name: 1,
      price: 1,
      category: 1,
      tags: 1,
      available: 1,
      autoInventory: 1,
      image: 1,
      description: 1,
      dietaryCategory: 1,
      preparationTime: 1,
      bufferTime: 1,
      ingredients: 1,
      createdAt: 1,
    };

    const allItems = await MenuItem.find(q, projection)
      .populate('ingredients.inventoryItemId', 'currentStock isActive name unit')
      .sort({ createdAt: -1 })
      .lean();

    const enrichedItems = [];
    for (const item of allItems) {
      try {
        const normalizedItem = normalizeMenuItem(item);
        const maxQty = await getMenuItemMaxQuantity(normalizedItem);
        const isAvailable = normalizedItem.available !== false && (normalizedItem.autoInventory ? maxQty > 0 : true);
        enrichedItems.push({
          ...normalizedItem,
          maxAvailableQuantity: maxQty,
          available: isAvailable,
        });
      } catch (error) {
        logger.error('INVENTORY', `Failed to normalize item ${item._id}: ${error.message}`, { error });
        // Skip malformed items but continue processing others
      }
    }

    const items = settings?.autoOutOfStock
      ? enrichedItems.filter((item) => item.available)
      : enrichedItems;

    const total = items.length;
    const pagedItems = items.slice(skip, skip + limitNum);

    res.json({
      items: pagedItems,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
        hasNext: skip + limitNum < total,
        hasPrev: pageNum > 1
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Admin + public trending — aggregate from completed-ish orders */
router.get('/trending', async (_req, res) => {
  try {
    const agg = await Order.aggregate([
      { $match: { cancelledAt: null, status: { $in: ['Preparing', 'Ready', 'Received', 'Confirmed', 'Queued'] } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.menuItemId',
          count: { $sum: '$items.quantity' },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 8 },
    ]);
    const ids = agg.map((a) => a._id).filter(Boolean);
    const items = await MenuItem.find({ _id: { $in: ids }, available: true });
    const map = new Map(items.map((i) => [i._id.toString(), i]));
    const ordered = agg.map((a) => map.get(a._id?.toString())).filter(Boolean);
    res.json({ items: ordered });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/all', authAdmin, async (req, res) => {
  try {
    const { ShopSettings } = await import('../models/ShopSettings.js');
    const settings = await ShopSettings.findOne();
    const items = await MenuItem.find()
      .populate('ingredients.inventoryItemId', 'currentStock isActive name unit')
      .sort({ category: 1, name: 1 })
      .lean();

    const normalizedItems = [];
    for (const item of items) {
      try {
        const normalizedItem = normalizeMenuItem(item);
        const maxQty = await getMenuItemMaxQuantity(normalizedItem);
        normalizedItems.push({
          ...normalizedItem,
          maxAvailableQuantity: maxQty,
          available: normalizedItem.available !== false && (normalizedItem.autoInventory ? maxQty > 0 : true),
        });
      } catch (error) {
        logger.error('INVENTORY', `Failed to normalize item ${item._id}: ${error.message}`, { error });
        // Skip malformed items but continue processing others
      }
    }

    res.json({ items: normalizedItems });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Admin CRUD with input validation ─────────────────────────── */

router.post('/', authAdmin, async (req, res) => {
  try {
    const {
      name,
      price,
      category,
      tags,
      available,
      autoInventory,
      image,
      description,
      subcategory,
      preparationTime,
      bufferTime,
      ingredients,
      variants,
      addOns,
      isBestSeller,
      isRecommended,
      isSeasonal,
      nutritionalInfo,
      gstRate,
      dietaryCategory,
    } = req.body;
    if (!name || price === undefined || !category) {
      return res.status(400).json({ error: 'Name, price, and category are required' });
    }

    const normalizedPrep = Number(preparationTime);
    const defaultPrep = String(category).trim() === 'Fries' ? 7 : 10;
    const normalizedDietaryCategory = ['Veg', 'Non-Veg', 'Egg', 'Unknown'].includes(String(dietaryCategory || ''))
      ? String(dietaryCategory)
      : 'Unknown';

    // Inventory mapping is OPTIONAL - only validate if provided
    let validatedIngredients = [];
    if (Array.isArray(ingredients) && ingredients.length > 0) {
      validatedIngredients = ingredients.filter(ing => {
        // Only include ingredients that have valid data
        return ing && (ing.name || ing.inventoryItemId);
      }).map(ing => ({
        inventoryItemId: ing.inventoryItemId || null,
        name: ing.name || 'Unknown',
        quantity: Number(ing.quantity) || 0,
        unit: ing.unit || 'pcs'
      }));
    }

    const item = await MenuItem.create({
      name: String(name).trim().slice(0, 100),
      price: Math.max(0, Number(price) || 0),
      category: String(category).trim(),
      subcategory: subcategory ? String(subcategory).trim().slice(0, 100) : '',
      tags: Array.isArray(tags) ? tags.map(t => String(t).trim()).slice(0, 5) : [],
      available: available !== false,
      autoInventory: !!autoInventory,
      image: image ? String(image).trim().slice(0, 500) : '',
      description: description ? String(description).trim().slice(0, 500) : '',
      dietaryCategory: normalizedDietaryCategory,
      preparationTime: Number.isFinite(normalizedPrep) && normalizedPrep >= 0 ? normalizedPrep : defaultPrep,
      bufferTime: Number.isFinite(Number(bufferTime)) ? Math.max(0, Number(bufferTime)) : 2,
      ingredients: validatedIngredients, // Optional inventory mapping
      variants: Array.isArray(variants) ? variants : [],
      addOns: Array.isArray(addOns) ? addOns : [],
      isBestSeller: !!isBestSeller,
      isRecommended: !!isRecommended,
      isSeasonal: !!isSeasonal,
      nutritionalInfo: nutritionalInfo && typeof nutritionalInfo === 'object' ? nutritionalInfo : undefined,
      gstRate: Number.isFinite(Number(gstRate)) ? Number(gstRate) : 5,
    });
    res.status(201).json({ item });
  } catch (e) {
    logger.error('ADMIN', `Menu item creation error: ${e.message}`, { error: e });
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', authAdmin, async (req, res) => {
  try {
    const updates = {};
    if (req.body.available !== undefined) updates.available = !!req.body.available;
    if (req.body.autoInventory !== undefined) updates.autoInventory = !!req.body.autoInventory;
    if (req.body.price !== undefined) updates.price = Math.max(0, Number(req.body.price) || 0);
    if (req.body.category !== undefined) updates.category = String(req.body.category).trim();
    if (req.body.name !== undefined) updates.name = String(req.body.name).trim().slice(0, 100);
    if (req.body.description !== undefined) updates.description = String(req.body.description).trim().slice(0, 500);
    if (req.body.image !== undefined) updates.image = String(req.body.image).trim().slice(0, 500);
    if (req.body.tags !== undefined) updates.tags = Array.isArray(req.body.tags) ? req.body.tags.map(t => String(t).trim()).slice(0, 5) : [];
    if (req.body.dietaryCategory !== undefined) {
      updates.dietaryCategory = ['Veg', 'Non-Veg', 'Egg', 'Unknown'].includes(String(req.body.dietaryCategory || ''))
        ? String(req.body.dietaryCategory)
        : 'Unknown';
    }

    const item = await MenuItem.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json({ item });
  } catch (e) {
    logger.error('ADMIN', `Menu item patch error: ${e.message}`, { error: e });
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', authAdmin, async (req, res) => {
  try {
    const {
      name,
      price,
      category,
      tags,
      available,
      autoInventory,
      image,
      description,
      subcategory,
      preparationTime,
      bufferTime,
      ingredients,
      variants,
      addOns,
      isBestSeller,
      isRecommended,
      isSeasonal,
      nutritionalInfo,
      gstRate,
      dietaryCategory,
    } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = String(name).trim().slice(0, 100);
    if (price !== undefined) updates.price = Math.max(0, Number(price) || 0);
    if (category !== undefined) updates.category = String(category).trim();
    if (subcategory !== undefined) updates.subcategory = String(subcategory).trim().slice(0, 100);
    if (tags !== undefined) updates.tags = Array.isArray(tags) ? tags.map(t => String(t).trim()).slice(0, 5) : [];
    if (available !== undefined) updates.available = !!available;
    if (autoInventory !== undefined) updates.autoInventory = !!autoInventory;
    if (image !== undefined) updates.image = String(image).trim().slice(0, 500);
    if (description !== undefined) updates.description = String(description).trim().slice(0, 500);
    if (dietaryCategory !== undefined) {
      updates.dietaryCategory = ['Veg', 'Non-Veg', 'Egg', 'Unknown'].includes(String(dietaryCategory || ''))
        ? String(dietaryCategory)
        : 'Unknown';
    }
    if (preparationTime !== undefined) {
      const prep = Number(preparationTime);
      updates.preparationTime = Number.isFinite(prep) && prep >= 0 ? prep : 10;
    }
    if (bufferTime !== undefined) updates.bufferTime = Number.isFinite(Number(bufferTime)) ? Math.max(0, Number(bufferTime)) : 2;
    if (ingredients !== undefined) {
      // Inventory mapping is OPTIONAL - only validate if provided
      if (Array.isArray(ingredients) && ingredients.length > 0) {
        updates.ingredients = ingredients.filter(ing => {
          return ing && (ing.name || ing.inventoryItemId);
        }).map(ing => ({
          inventoryItemId: ing.inventoryItemId || null,
          name: ing.name || 'Unknown',
          quantity: Number(ing.quantity) || 0,
          unit: ing.unit || 'pcs'
        }));
      } else {
        updates.ingredients = [];
      }
    }
    if (variants !== undefined) updates.variants = Array.isArray(variants) ? variants : [];
    if (addOns !== undefined) updates.addOns = Array.isArray(addOns) ? addOns : [];
    if (isBestSeller !== undefined) updates.isBestSeller = !!isBestSeller;
    if (isRecommended !== undefined) updates.isRecommended = !!isRecommended;
    if (isSeasonal !== undefined) updates.isSeasonal = !!isSeasonal;
    if (nutritionalInfo !== undefined) updates.nutritionalInfo = nutritionalInfo && typeof nutritionalInfo === 'object' ? nutritionalInfo : {};
    if (gstRate !== undefined) updates.gstRate = Number.isFinite(Number(gstRate)) ? Number(gstRate) : 5;

    const item = await MenuItem.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json({ item });
  } catch (e) {
    logger.error('ADMIN', `Menu item update error: ${e.message}`, { error: e });
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', authAdmin, async (req, res) => {
  try {
    await MenuItem.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Image upload endpoint ────────────────────────────────────── */
router.post('/upload-image', authAdmin, (req, res, next) => {
  menuUpload.single('image')(req, res, (err) => {
    if (err) {
      logger.error('ADMIN', `Image upload error: ${err.message}`, { error: err });
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}, (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const imageUrl = `/uploads/menu/${req.file.filename}`;
    logger.success('ADMIN', `Image uploaded successfully: ${imageUrl}`);
    res.json({ imageUrl });
  } catch (e) {
    logger.error('ADMIN', `Image upload processing error: ${e.message}`, { error: e });
    res.status(500).json({ error: 'Failed to process uploaded image' });
  }
});

/* ── New Item Popup Routes ────────────────────────────────────── */

// Get pending new item popup for user
router.get('/new-item-popup', authUser, requireUser, async (req, res) => {
  try {
    const userId = req.user._id;
    
    // Find menu items marked as new
    const newItems = await MenuItem.find({ 
      showAsNew: true, 
      available: true 
    }).sort({ popupPriority: -1, dateAdded: -1 }).lean();
    
    if (!newItems.length) {
      return res.json({ popup: null });
    }
    
    // Find which items the user has already seen
    const seenItemIds = await NewItemPopup.distinct('menuItemId', { 
      userId,
      shown: true 
    });
    
    // Find first item not yet shown
    const pendingItem = newItems.find(item => !seenItemIds.includes(item._id.toString()));
    
    if (!pendingItem) {
      return res.json({ popup: null });
    }
    
    res.json({ 
      popup: {
        menuItemId: pendingItem._id,
        name: pendingItem.name,
        price: pendingItem.price,
        image: pendingItem.popupImage || pendingItem.image,
        description: pendingItem.popupDescription || pendingItem.description,
        dateAdded: pendingItem.dateAdded
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mark popup as shown
router.post('/new-item-popup/:menuItemId/shown', authUser, requireUser, async (req, res) => {
  try {
    const userId = req.user._id;
    const { menuItemId } = req.params;
    
    await NewItemPopup.findOneAndUpdate(
      { userId, menuItemId },
      { 
        shown: true, 
        shownAt: new Date() 
      },
      { upsert: true }
    );
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mark popup as dismissed
router.post('/new-item-popup/:menuItemId/dismiss', authUser, requireUser, async (req, res) => {
  try {
    const userId = req.user._id;
    const { menuItemId } = req.params;
    
    await NewItemPopup.findOneAndUpdate(
      { userId, menuItemId },
      { 
        dismissed: true, 
        dismissedAt: new Date() 
      },
      { upsert: true }
    );
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mark popup as clicked (user ordered the item)
router.post('/new-item-popup/:menuItemId/clicked', authUser, requireUser, async (req, res) => {
  try {
    const userId = req.user._id;
    const { menuItemId } = req.params;
    
    await NewItemPopup.findOneAndUpdate(
      { userId, menuItemId },
      { 
        clicked: true, 
        clickedAt: new Date() 
      },
      { upsert: true }
    );
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/check-stock/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { ShopSettings } = await import('../models/ShopSettings.js');

    const settings = await ShopSettings.findOne();
    if (!settings || !settings.autoOutOfStock) {
      return res.json({ inStock: true, autoOutOfStock: false });
    }

    const menuItem = await MenuItem.findById(id).populate('ingredients.inventoryItemId');
    if (!menuItem) return res.status(404).json({ error: 'Menu item not found' });
    if (menuItem.autoInventory !== true) {
      return res.json({ inStock: true, autoOutOfStock: false });
    }

    if (!menuItem.ingredients || menuItem.ingredients.length === 0) {
      return res.json({ inStock: true, autoOutOfStock: true });
    }

    for (const ingredient of menuItem.ingredients) {
      const inventoryItem = ingredient.inventoryItemId;
      if (inventoryItem && inventoryItem.currentStock < ingredient.quantity) {
        return res.json({ 
          inStock: false, 
          autoOutOfStock: true,
          reason: `${ingredient.name} is out of stock`
        });
      }
    }

    res.json({ inStock: true, autoOutOfStock: true });
  } catch (e) {
    logger.error('INVENTORY', `Stock check error: ${e.message}`, { error: e });
    res.status(500).json({ error: e.message });
  }
});

// Admin: Reset all popup tracking for a specific item
router.post('/new-item-popup/:menuItemId/reset', authAdmin, async (req, res) => {
  try {
    const { menuItemId } = req.params;
    
    await NewItemPopup.deleteMany({ menuItemId });
    
    res.json({ success: true, message: 'Popup tracking reset for this item' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: Reset all popup tracking (for all items)
router.post('/new-item-popup/reset-all', authAdmin, async (req, res) => {
  try {
    await NewItemPopup.deleteMany({});
    
    res.json({ success: true, message: 'All popup tracking reset' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



export default router;
