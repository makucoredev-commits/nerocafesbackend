import 'dotenv/config';
import mongoose from 'mongoose';

async function run() {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    console.log('Connected to MongoDB Atlas');

    const result = await mongoose.connection.db.collection('admins').updateOne(
      { email: 'nerocafes14@gmail.com' },
      { 
        $set: { 
          role: 'SUPER_ADMIN',
          allowedBranches: ['branch_001', 'branch_002', 'branch_003']
        } 
      }
    );
    console.log('Update result:', result);

    const admin = await mongoose.connection.db.collection('admins').findOne(
      { email: 'nerocafes14@gmail.com' },
      { projection: { email: 1, role: 1, allowedBranches: 1, branchId: 1 } }
    );
    console.log('Verified Admin in DB:', admin);
  } catch (err) {
    console.error('Error upgrading admin:', err);
  } finally {
    await mongoose.disconnect();
  }
}

run();
