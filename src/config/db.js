import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');

  logger.info('DATABASE', 'Mongo Connecting...');

  const options = {
    serverSelectionTimeoutMS: 5000, // Timeout for server selection
    socketTimeoutMS: 45000, // Socket timeout
    maxPoolSize: 10, // Maximum connection pool size
    minPoolSize: 2, // Minimum connection pool size
    maxIdleTimeMS: 30000, // Close idle connections after 30s
    retryWrites: true, // Retry failed writes
    retryReads: true, // Retry failed reads
  };

  // Mask credentials for startup log safety
  const maskedUri = uri.replace(/:([^@]+)@/, ':******@');
  logger.debug('DATABASE', `Connecting to MONGODB_URI: ${maskedUri}`);

  // Register global schema plugin to trace Mongo query durations
  mongoose.plugin((schema) => {
    // Before query execution starts
    schema.pre(['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'countDocuments', 'aggregate'], function() {
      this._startTime = Date.now();
      logger.trace('DATABASE', `Query Started: ${this.model?.modelName || 'Schema'}.${this.op || 'query'}`);
    });

    // After query execution finishes
    schema.post(['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'countDocuments', 'aggregate'], function(res) {
      if (this._startTime) {
        const duration = Date.now() - this._startTime;
        logger.info('DATABASE', `Query Completed: ${this.model?.modelName || 'Schema'}.${this.op || 'query'} in ${duration}ms`, {
          duration,
        });
      }
    });

    // Before save validation starts (document level)
    schema.pre('save', function() {
      this._startTime = Date.now();
      logger.trace('DATABASE', `Document Save Started: ${this.constructor.modelName}`);
    });

    // After save completes
    schema.post('save', function() {
      if (this._startTime) {
        const duration = Date.now() - this._startTime;
        logger.info('DATABASE', `Document Saved: ${this.constructor.modelName} in ${duration}ms`, {
          duration,
        });
      }
    });
  });

  await mongoose.connect(uri, options);

  // Parse db name
  let dbName = 'unknown';
  try {
    const match = uri.match(/\/([^/?]+)(\?|$)/);
    if (match) dbName = match[1];
  } catch (e) {}

  logger.success('DATABASE', `Mongo Connected. Database: ${dbName}`);

  // Monitor connection events
  mongoose.connection.on('error', (err) => {
    logger.error('DATABASE', 'Mongo Connection error', { err });
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('DATABASE', 'Mongo Disconnected');
  });

  mongoose.connection.on('reconnected', () => {
    logger.success('DATABASE', 'Mongo Reconnected');
  });
}
