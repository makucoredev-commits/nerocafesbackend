import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { connectDB } from '../config/db.js';
import { syncAllUsersToCustomers } from './customerSync.js';

await connectDB();
const count = await syncAllUsersToCustomers();
console.log(`Synced ${count} users to Customer CRM`);
process.exit(0);
