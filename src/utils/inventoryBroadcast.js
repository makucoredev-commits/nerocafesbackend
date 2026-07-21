import { MenuItem } from '../models/MenuItem.js';
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
 * Broadcasts stock updates for a list of menu items to all connected socket clients.
 */
export async function broadcastMenuItemsStock(io, menuItems) {
  if (!io) return;
  for (const item of menuItems) {
    const maxQty = await getMenuItemMaxQuantity(item);
    io.emit('menu:stock-update', {
      menuItemId: item._id.toString(),
      maxQuantity: maxQty,
      outOfStock: maxQty <= 0
    });
  }
}

/**
 * Finds all menu items linked to a given inventory item and broadcasts their updated stock.
 */
export async function broadcastInventoryStockChange(io, inventoryItemId) {
  if (!io) return;
  try {
    const affectedMenuItems = await MenuItem.find({
      'ingredients.inventoryItemId': inventoryItemId
    }).populate('ingredients.inventoryItemId');
    
    await broadcastMenuItemsStock(io, affectedMenuItems);
  } catch (error) {
    logger.error('INVENTORY', `Error broadcasting stock change for inventory item ${inventoryItemId}: ${error.message}`, { error });
  }
}
