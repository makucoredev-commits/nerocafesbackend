import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devEnvPath = path.resolve(__dirname, '../.env.dev');
const prodEnvPath = path.resolve(__dirname, '../.env');

if (fs.existsSync(devEnvPath)) {
  dotenv.config({ path: devEnvPath });
} else {
  dotenv.config({ path: prodEnvPath });
}

import mongoose from 'mongoose';
import { connectDB } from './config/db.js';
import { Admin } from './models/Admin.js';
import { MenuItem } from './models/MenuItem.js';
import { OfferBanner } from './models/OfferBanner.js';
import { WhatsAppTemplate } from './models/WhatsAppTemplate.js';
import { getOrCreateShopSettings } from './models/ShopSettings.js';

const menuSeed = [
  // BURGERS
  { name: 'Classic Veg Burger', price: 110, category: 'Burgers', dietaryCategory: 'Veg', preparationTime: 12, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Tandoori Veg Burger', price: 110, category: 'Burgers', dietaryCategory: 'Veg', preparationTime: 12, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Classic Chicken Burger', price: 130, category: 'Burgers', dietaryCategory: 'Non-Veg', preparationTime: 12, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Tandoori Chicken Burger', price: 130, category: 'Burgers', dietaryCategory: 'Non-Veg', preparationTime: 12, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Classic Paneer Burger', price: 130, category: 'Burgers', dietaryCategory: 'Veg', preparationTime: 12, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Tandoori Paneer Burger', price: 130, category: 'Burgers', dietaryCategory: 'Veg', preparationTime: 12, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Classic Egg Burger', price: 110, category: 'Burgers', dietaryCategory: 'Egg', preparationTime: 12, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Tandoori Egg Burger', price: 110, category: 'Burgers', dietaryCategory: 'Egg', preparationTime: 12, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },

  // SANDWICHES
  { name: 'Mediterranean Chicken Sandwich', price: 100, category: 'Sandwiches', dietaryCategory: 'Non-Veg', preparationTime: 10, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Tandoori Chicken Sandwich', price: 110, category: 'Sandwiches', dietaryCategory: 'Non-Veg', preparationTime: 10, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Mayo Chicken Sandwich', price: 100, category: 'Sandwiches', dietaryCategory: 'Non-Veg', preparationTime: 10, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Italian Veg Sandwich', price: 90, category: 'Sandwiches', dietaryCategory: 'Veg', preparationTime: 10, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Cheese Melt Sandwich', price: 100, category: 'Sandwiches', dietaryCategory: 'Veg', preparationTime: 10, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Mayo Egg Sandwich', price: 100, category: 'Sandwiches', dietaryCategory: 'Egg', preparationTime: 10, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Paneer Sandwich', price: 110, category: 'Sandwiches', dietaryCategory: 'Veg', preparationTime: 10, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },

  // PIZZA
  { name: 'Veg Supreme Pizza', price: 120, category: 'Pizza', dietaryCategory: 'Veg', preparationTime: 15, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Margherita Pizza', price: 140, category: 'Pizza', dietaryCategory: 'Veg', preparationTime: 15, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Corn & Cheese Pizza', price: 130, category: 'Pizza', dietaryCategory: 'Veg', preparationTime: 15, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Chicken Pizza', price: 160, category: 'Pizza', dietaryCategory: 'Non-Veg', preparationTime: 15, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Paneer Peri Peri Pizza', price: 150, category: 'Pizza', dietaryCategory: 'Veg', preparationTime: 15, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },

  // MAGGIE
  { name: 'Veg Maggie', price: 110, category: 'Maggie', dietaryCategory: 'Veg', preparationTime: 8, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Egg Maggie', price: 120, category: 'Maggie', dietaryCategory: 'Egg', preparationTime: 8, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Chicken Maggie', price: 130, category: 'Maggie', dietaryCategory: 'Non-Veg', preparationTime: 8, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },

  // FRIES
  { name: 'French Fries', price: 90, category: 'Fries', dietaryCategory: 'Veg', preparationTime: 6, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Peri Peri Fries', price: 100, category: 'Fries', dietaryCategory: 'Veg', preparationTime: 6, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },

  // DRINKS
  { name: 'Diet Coke', price: 50, category: 'Drinks', dietaryCategory: 'Veg', preparationTime: 2, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Thums Up', price: 40, category: 'Drinks', dietaryCategory: 'Veg', preparationTime: 2, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
  { name: 'Red Bull', price: 125, category: 'Drinks', dietaryCategory: 'Veg', preparationTime: 2, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },

  // ADD-ONS
  { name: 'Cheese Slice', price: 15, category: 'Add-ons', dietaryCategory: 'Veg', preparationTime: 0, bufferTime: 0, image: '', available: true, tags: [], ingredients: [], variants: [], addOns: [], isBestSeller: false, isRecommended: false, isSeasonal: false },
];

async function run() {
  await connectDB();
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'nerocafes14@gmail.com';
  const adminPass = process.env.SEED_ADMIN_PASSWORD || 'NeroCafe2026';
  const exists = await Admin.findOne({ email: adminEmail });
  if (!exists) {
    await Admin.create({ name: 'Nero Admin', email: adminEmail, password: adminPass });
    console.log('Admin created:', adminEmail);
  } else {
    exists.password = adminPass;
    await exists.save();
    console.log('Admin password updated:', adminEmail);
  }

  // Clear existing menu so we can re-seed with clean data
  await MenuItem.deleteMany({});
  await MenuItem.insertMany(menuSeed.map((m) => ({ ...m, available: true })));
  console.log('Menu seeded with', menuSeed.length, 'items');

  const b = await OfferBanner.findOne({ active: true });
  if (!b) {
    await OfferBanner.create({
      title: 'Fresh Drop',
      message: 'Freshly prepared food for your next order — Order now!',
      active: true,
    });
    console.log('Banner seeded');
  }

  // Seed WhatsApp templates
  const templateCount = await WhatsAppTemplate.countDocuments();
  if (templateCount === 0) {
    const templates = [
      {
        name: 'order_started',
        description: 'Order confirmation message',
        messageType: 'confirmation',
        messageBody: 'Hey {{1}},\n\nYour order {{2}} has been received. We are preparing your delicious meal. You\'ll be notified when it\'s ready!\n\nEnjoy your meal ☕',
        variables: ['name', 'order_no'],
        enabled: true,
        isApproved: true,
        metaStatus: 'approved',
      },
      {
        name: 'order_ready',
        description: 'Order placed with tracking',
        messageType: 'confirmation',
        messageBody: 'Hey {{1}},\n\nYour order {{2}} has been placed successfully! 🎉\n\nTrack your order: {{3}}\n\nWe\'ll notify you when it\'s ready for pickup.',
        variables: ['name', 'order_no', 'track_link'],
        enabled: true,
        isApproved: true,
        metaStatus: 'approved',
      },
      {
        name: 'order_can',
        description: 'Order cancellation message',
        messageType: 'cancellation',
        messageBody: 'Hi {{1}},\n\nYour order {{2}} has been cancelled.\n\nSorry for the inconvenience 💛\nWe\'re here if you need help.\n\nReply STOP to opt out.',
        variables: ['name', 'order_no'],
        enabled: true,
        isApproved: true,
        metaStatus: 'approved',
      },
    ];
    await WhatsAppTemplate.insertMany(templates);
    console.log('WhatsApp templates seeded:', templates.length);
  }

  await getOrCreateShopSettings();
  console.log('Shop settings ready');

  await mongoose.disconnect();
  console.log('Done');
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
