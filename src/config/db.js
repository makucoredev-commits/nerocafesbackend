import mongoose from 'mongoose';

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');

  // Configure connection options for better performance
  const options = {
    serverSelectionTimeoutMS: 5000, // Timeout for server selection
    socketTimeoutMS: 45000, // Socket timeout
    maxPoolSize: 10, // Maximum connection pool size
    minPoolSize: 2, // Minimum connection pool size
    maxIdleTimeMS: 30000, // Close idle connections after 30s
    retryWrites: true, // Retry failed writes
    retryReads: true, // Retry failed reads
  };

  await mongoose.connect(uri, options);
  console.log('MongoDB connected');

  // Monitor connection events
  mongoose.connection.on('error', (err) => {
    console.error('[MongoDB] Connection error:', err);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('[MongoDB] Disconnected');
  });

  mongoose.connection.on('reconnected', () => {
    console.log('[MongoDB] Reconnected');
  });
}
