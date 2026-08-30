import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from './src/models/Order.js';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI missing');
  process.exit(1);
}

await mongoose.connect(uri);
const now = new Date();

const res = await Order.updateMany(
  { orderNo: { $in: [15, 16] }, cancelledAt: null },
  { $set: { status: 'Completed', remainingTime: 0, readyAt: now } }
);

const orders = await Order.find({ orderNo: { $in: [15, 16] } })
  .select('orderNo status cancelledAt readyAt');

console.log(JSON.stringify({ matched: res.matchedCount, modified: res.modifiedCount, orders }, null, 2));
await mongoose.disconnect();
