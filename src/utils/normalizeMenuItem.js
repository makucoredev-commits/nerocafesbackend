/**
 * Menu Item Data Normalization Utility
 * Ensures backward compatibility with different database versions
 * Applies safe defaults for missing or invalid fields
 */

/**
 * Normalize a single menu item document
 * @param {Object} item - Raw menu item from database
 * @returns {Object} Normalized menu item with safe defaults
 */
export const normalizeMenuItem = (item) => {
  if (!item || typeof item !== 'object') {
    console.warn('[normalizeMenuItem] Invalid item received:', item);
    return null;
  }

  try {
    return {
      _id: item._id,
      name: String(item.name || '').trim() || 'Unnamed Item',
      price: Math.max(0, Number(item.price) || 0),
      costPrice: Math.max(0, Number(item.costPrice) || 0),
      category: item.category || null,
      subcategory: String(item.subcategory || '').trim(),
      tags: Array.isArray(item.tags) ? item.tags : [],
      available: item.available !== false,
      autoInventory: !!item.autoInventory,
      image: String(item.image || '').trim(),
      description: String(item.description || '').trim(),
      orderCount: Math.max(0, Number(item.orderCount) || 0),
      dietaryCategory: ['Veg', 'Non-Veg', 'Egg', 'Unknown'].includes(String(item.dietaryCategory || ''))
        ? String(item.dietaryCategory)
        : 'Unknown',
      preparationTime: Math.max(0, Number(item.preparationTime) || 10),
      bufferTime: Math.max(0, Number(item.bufferTime) || 2),
      // Normalize arrays - always return arrays, never undefined
      ingredients: Array.isArray(item.ingredients) ? item.ingredients : [],
      variants: Array.isArray(item.variants) ? item.variants : [],
      addOns: Array.isArray(item.addOns) ? item.addOns : [],
      // Flags
      isBestSeller: !!item.isBestSeller,
      isRecommended: !!item.isRecommended,
      isSeasonal: !!item.isSeasonal,
      // New Item Popup Settings
      showAsNew: !!item.showAsNew,
      dateAdded: item.dateAdded || new Date(),
      popupPriority: Math.max(0, Number(item.popupPriority) || 0),
      popupImage: String(item.popupImage || '').trim(),
      popupDescription: String(item.popupDescription || '').trim(),
      // Nutritional Info
      nutritionalInfo: {
        calories: Math.max(0, Number(item.nutritionalInfo?.calories) || 0),
        protein: Math.max(0, Number(item.nutritionalInfo?.protein) || 0),
        carbs: Math.max(0, Number(item.nutritionalInfo?.carbs) || 0),
        fat: Math.max(0, Number(item.nutritionalInfo?.fat) || 0),
      },
      // GST
      gstRate: Math.max(0, Number(item.gstRate) || 5),
      // Timestamps
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  } catch (error) {
    console.error('[normalizeMenuItem] Error normalizing item:', item._id, error);
    // Return minimal safe object to prevent crashes
    return {
      _id: item._id,
      name: String(item.name || 'Error Loading Item'),
      price: 0,
      costPrice: 0,
      category: null,
      subcategory: '',
      tags: [],
      available: false,
      autoInventory: false,
      image: '',
      description: 'Error loading item data',
      orderCount: 0,
      dietaryCategory: 'Unknown',
      preparationTime: 10,
      bufferTime: 2,
      ingredients: [],
      variants: [],
      addOns: [],
      isBestSeller: false,
      isRecommended: false,
      isSeasonal: false,
      showAsNew: false,
      dateAdded: new Date(),
      popupPriority: 0,
      popupImage: '',
      popupDescription: '',
      nutritionalInfo: { calories: 0, protein: 0, carbs: 0, fat: 0 },
      gstRate: 5,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
};

/**
 * Normalize an array of menu items
 * @param {Array} items - Raw menu items from database
 * @returns {Array} Normalized menu items
 */
export const normalizeMenuItems = (items) => {
  if (!Array.isArray(items)) {
    console.warn('[normalizeMenuItems] Invalid items received, expected array:', items);
    return [];
  }

  const normalized = [];
  const errors = [];

  for (const item of items) {
    try {
      const normalizedItem = normalizeMenuItem(item);
      if (normalizedItem) {
        normalized.push(normalizedItem);
      }
    } catch (error) {
      errors.push({ itemId: item?._id, error: error.message });
      console.error('[normalizeMenuItems] Failed to normalize item:', item?._id, error);
    }
  }

  if (errors.length > 0) {
    console.warn(`[normalizeMenuItems] ${errors.length} items failed to normalize. Continuing with ${normalized.length} valid items.`);
  }

  return normalized;
};

/**
 * Safe array accessor - returns empty array if undefined/null
 * @param {Array} arr - Array to access
 * @returns {Array} The array or empty array if undefined
 */
export const safeArray = (arr) => {
  return Array.isArray(arr) ? arr : [];
};

/**
 * Safe number accessor - returns 0 if undefined/null/NaN
 * @param {Number} num - Number to access
 * @returns {Number} The number or 0 if invalid
 */
export const safeNumber = (num) => {
  const parsed = Number(num);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Safe string accessor - returns empty string if undefined/null
 * @param {String} str - String to access
 * @returns {String} The string or empty string if undefined
 */
export const safeString = (str) => {
  return String(str || '').trim();
};
