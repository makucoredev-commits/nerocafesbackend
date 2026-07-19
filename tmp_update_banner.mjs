import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { connectDB } from './src/config/db.js';
import { OfferBanner } from './src/models/OfferBanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devEnvPath = path.resolve(__dirname, '.env.dev');
const prodEnvPath = path.resolve(__dirname, '.env');

if (fs.existsSync(devEnvPath)) {
  dotenv.config({ path: devEnvPath });
} else {
  dotenv.config({ path: prodEnvPath });
}

await connectDB();

const result = await OfferBanner.updateMany(
  {
    $or: [
      { title: { $regex: 'ritual', $options: 'i' } },
      { message: { $regex: 'ritual', $options: 'i' } },
    ],
  },
  {
    $set: {
      title: 'Fresh Drop',
      message: 'Freshly prepared food for your next order — Order now!',
      active: true,
    },
  }
);

const banners = await OfferBanner.find({ active: true }).sort({ createdAt: -1 }).lean();
console.log(JSON.stringify({ matched: result.matchedCount, modified: result.modifiedCount, banners }, null, 2));
await mongoose.disconnect();
