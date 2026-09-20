import mongoose from 'mongoose';

const uri = 'mongodb://Nerocafes:nerocafes2026@ac-dvvxwaq-shard-00-00.5cmdfbw.mongodb.net:27017,ac-dvvxwaq-shard-00-01.5cmdfbw.mongodb.net:27017,ac-dvvxwaq-shard-00-02.5cmdfbw.mongodb.net:27017/nerocafe_dev?ssl=true&replicaSet=atlas-hx41dm-shard-0&authSource=admin&appName=Cluster0';

async function cleanup() {
  await mongoose.connect(uri);
  const del = await mongoose.connection.db.collection('blockeddevices').deleteMany({
    target: { $in: ['127.0.0.1', '::1', 'localhost'] }
  });
  console.log('Removed localhost blocks from nerocafe_dev:', del);

  // Also unrevoke any falsely revoked sessions
  const unrevoke = await mongoose.connection.db.collection('sessionpresences').updateMany(
    {},
    { $set: { isRevoked: false } }
  );
  console.log('Restored sessions:', unrevoke);

  await mongoose.disconnect();
}

cleanup();
