import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from './src/models/Order.js';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI missing');
  process.exit(1);
}

await mongoose.connect(uri);
const specifically = await Order.find({ orderNo: { $in: [15, 16] } })
  .select('orderNo status cancelledAt createdAt customer.name customer.phone');
const lowerRange = await Order.find({ orderNo: { $lte: 20 } })
  .sort({ orderNo: 1 })
  .select('orderNo status cancelledAt createdAt customer.name customer.phone');

console.log(JSON.stringify({ specific: specifically, lowRange: lowerRange }, null, 2));
await mongoose.disconnect();
