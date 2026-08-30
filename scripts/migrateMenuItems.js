/**
 * Menu Item Migration Script
 * One-time migration to add missing fields to existing menu documents
 * Never overwrites existing data, only adds missing fields
 */

import mongoose from 'mongoose';
import { MenuItem } from '../src/models/MenuItem.js';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULTS = {
  costPrice: 0,
  subcategory: '',
  tags: [],
  available: true,
  autoInventory: false,
  image: '',
  description: '',
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
  popupPriority: 0,
  popupImage: '',
  popupDescription: '',
  nutritionalInfo: {
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0
  },
  gstRate: 5
};

const FIELD_TYPES = {
  costPrice: 'number',
  subcategory: 'string',
  tags: 'array',
  available: 'boolean',
  autoInventory: 'boolean',
  image: 'string',
  description: 'string',
  orderCount: 'number',
  dietaryCategory: 'string',
  preparationTime: 'number',
  bufferTime: 'number',
  ingredients: 'array',
  variants: 'array',
  addOns: 'array',
  isBestSeller: 'boolean',
  isRecommended: 'boolean',
  isSeasonal: 'boolean',
  showAsNew: 'boolean',
  popupPriority: 'number',
  popupImage: 'string',
  popupDescription: 'string',
  nutritionalInfo: 'object',
  gstRate: 'number'
};

/**
 * Check if a field is missing or invalid
 */
function isFieldMissingOrInvalid(item, field) {
  const value = item[field];
  const type = FIELD_TYPES[field];

  if (value === undefined || value === null) {
    return true;
  }

  switch (type) {
    case 'number':
      return typeof value !== 'number' || isNaN(value);
    case 'string':
      return typeof value !== 'string';
    case 'boolean':
      return typeof value !== 'boolean';
    case 'array':
      return !Array.isArray(value);
    case 'object':
      return typeof value !== 'object' || value === null || Array.isArray(value);
    default:
      return false;
  }
}

/**
 * Generate update object with only missing/invalid fields
 */
function generateUpdate(item) {
  const update = {};
  const missingFields = [];

  for (const field of Object.keys(DEFAULTS)) {
    if (isFieldMissingOrInvalid(item, field)) {
      update[field] = DEFAULTS[field];
      missingFields.push(field);
    }
  }

  return { update, missingFields };
}

/**
 * Main migration function
 */
async function migrateMenuItems() {
  console.log('========================================');
  console.log('Menu Item Migration Script');
  console.log('========================================\n');

  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI or MONGO_URI environment variable not set');
    }

    console.log(`Connecting to MongoDB...`);
    await mongoose.connect(mongoUri);
    console.log('✓ Connected to MongoDB\n');

    // Get all menu items
    console.log('Fetching all menu items...');
    const allItems = await MenuItem.find().lean();
    console.log(`✓ Found ${allItems.length} menu items\n`);

    // Process each item
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors = [];
    const fieldStats = {};

    for (const item of allItems) {
      try {
        const { update, missingFields } = generateUpdate(item);

        if (Object.keys(update).length === 0) {
          skippedCount++;
          console.log(`[SKIP] Item "${item.name}" (${item._id}) - No missing fields`);
          continue;
        }

        // Track which fields are being updated
        for (const field of missingFields) {
          fieldStats[field] = (fieldStats[field] || 0) + 1;
        }

        // Apply update
        await MenuItem.findByIdAndUpdate(item._id, { $set: update });
        updatedCount++;
        console.log(`[UPDATE] Item "${item.name}" (${item._id}) - Added: ${missingFields.join(', ')}`);

      } catch (error) {
        errorCount++;
        errors.push({
          itemId: item._id,
          itemName: item.name,
          error: error.message
        });
        console.error(`[ERROR] Item "${item.name}" (${item._id}):`, error.message);
      }
    }

    // Print summary
    console.log('\n========================================');
    console.log('Migration Summary');
    console.log('========================================');
    console.log(`Total items processed: ${allItems.length}`);
    console.log(`✓ Updated: ${updatedCount}`);
    console.log(`⊘ Skipped: ${skippedCount}`);
    console.log(`✗ Errors: ${errorCount}`);

    if (Object.keys(fieldStats).length > 0) {
      console.log('\nFields Added (count):');
      for (const [field, count] of Object.entries(fieldStats).sort((a, b) => b[1] - a[1])) {
        console.log(`  - ${field}: ${count}`);
      }
    }

    if (errors.length > 0) {
      console.log('\nErrors:');
      for (const err of errors) {
        console.log(`  - ${err.itemName} (${err.itemId}): ${err.error}`);
      }
    }

    console.log('\n========================================');
    console.log('Migration Complete');
    console.log('========================================');

  } catch (error) {
    console.error('\nFatal error during migration:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

// Run migration
migrateMenuItems().catch(error => {
  console.error('Migration failed:', error);
  process.exit(1);
});
