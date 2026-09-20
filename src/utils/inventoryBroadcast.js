import { MenuItem as GlobalMenuItem } from '../models/MenuItem.js';
import { branchDbManager } from '../config/branchDbManager.js';
import { logger } from './logger.js';

/**
 * Calculates the maximum quantity of a menu item that can be made
 * based on the current stock of its ingredients.
 */
export async function getMenuItemMaxQuantity(menuItem) {
  if (!menuItem.autoInventory) {
    return 9999;
  }
  const ingredients = menuItem.ingredients || [];
  if (ingredients.length === 0) {
    return 9999;
  }
  
  let minQty = 9999;
  let hasInventoryLink = false;

  for (const ing of ingredients) {
    const inv = ing.inventoryItemId;
    if (inv && inv.isActive !== false) {
      hasInventoryLink = true;
      const stock = typeof inv === 'object' && 'currentStock' in inv ? inv.currentStock : 0;
      const needed = ing.quantity || 1;
      const possible = Math.floor(stock / needed);
      if (possible < minQty) {
        minQty = possible;
      }
    }
  }
  
  return hasInventoryLink ? Math.max(0, minQty) : 9999;
}

/**
 * Broadcasts stock updates for a list of menu items to connected socket clients.
 */
export async function broadcastMenuItemsStock(io, menuItems, branchId = 'branch_001') {
  if (!io) return;
  for (const item of menuItems) {
    const maxQty = await getMenuItemMaxQuantity(item);
    const payload = {
      menuItemId: item._id.toString(),
      maxQuantity: maxQty,
      outOfStock: maxQty <= 0,
      branchId,
    };
    io.to(`branch:${branchId}`).emit('menu:stock-update', payload);
    io.to(`branch:${branchId}:kitchen`).emit('menu:stock-update', payload);
    io.to(`branch:${branchId}:admin`).emit('menu:stock-update', payload);
    io.emit('menu:stock-update', payload);
  }
}

/**
 * Finds all menu items linked to a given inventory item in a branch and broadcasts their updated stock.
 */
export async function broadcastInventoryStockChange(io, inventoryItemId, branchId = 'branch_001') {
  if (!io) return;
  try {
    let MenuItemModel;
    try {
      MenuItemModel = await branchDbManager.getBranchModel(branchId, 'MenuItem');
    } catch {
      MenuItemModel = GlobalMenuItem;
    }

    const affectedMenuItems = await MenuItemModel.find({
      'ingredients.inventoryItemId': inventoryItemId
    }).populate('ingredients.inventoryItemId');
    
    await broadcastMenuItemsStock(io, affectedMenuItems, branchId);
  } catch (error) {
    logger.error('INVENTORY', `Error broadcasting stock change for inventory item ${inventoryItemId} (branch: ${branchId}): ${error.message}`, { error });
  }
}
