import { MenuItem } from '../models/MenuItem.js';

const ALLOWED = new Set(['Veg', 'Non-Veg', 'Egg']);

function inferDietaryCategory(name = '') {
  const normalized = String(name).trim().toLowerCase();

  if (!normalized) return null;

  if (/(chicken|mayo chicken|tandoori chicken|classic chicken|chicken burger|chicken sandwich|chicken pizza|chicken maggie)/i.test(name)) {
    return 'Non-Veg';
  }

  if (/(egg|mayo egg|egg burger|egg sandwich|egg maggie)/i.test(name)) {
    return 'Egg';
  }

  if (/(paneer|veg|margherita|cheese|melt|supreme|italian veg|veggie|vegetarian)/i.test(name)) {
    return 'Veg';
  }

  return null;
}

export async function migrateMenuDietaryCategories() {
  const items = await MenuItem.find({}).lean();
  let migrated = 0;

  for (const item of items) {
    const current = String(item.dietaryCategory || '').trim();
    const inferred = inferDietaryCategory(item.name);

    if (!current && inferred) {
      await MenuItem.updateOne({ _id: item._id }, { $set: { dietaryCategory: inferred } });
      migrated += 1;
      continue;
    }

    if (current && !ALLOWED.has(current)) {
      const fallback = inferred || 'Unknown';
      if (fallback !== 'Unknown') {
        await MenuItem.updateOne({ _id: item._id }, { $set: { dietaryCategory: fallback } });
        migrated += 1;
      }
    }
  }

  console.log(`[Dietary Migration] Updated ${migrated} menu items using dietaryCategory normalization.`);
}
