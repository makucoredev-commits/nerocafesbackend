import mongoose from 'mongoose';
import { Branch } from '../models/Branch.js';
import { logger } from '../utils/logger.js';

// Schemas
import { Order } from '../models/Order.js';
import { MenuItem } from '../models/MenuItem.js';
import { InventoryItem, StockMovement, PurchaseOrder, Supplier, WasteRecord } from '../models/Inventory.js';
import { Coupon } from '../models/Coupon.js';
import { Customer } from '../models/Customer.js';
import { ShopSettings } from '../models/ShopSettings.js';
import { Counter } from '../models/Counter.js';
import { AuditLog } from '../models/AuditLog.js';
import { SessionPresence } from '../models/SessionPresence.js';

const SCHEMAS = {
  Order: Order.schema,
  MenuItem: MenuItem.schema,
  InventoryItem: InventoryItem.schema,
  StockMovement: StockMovement.schema,
  PurchaseOrder: PurchaseOrder.schema,
  Supplier: Supplier.schema,
  WasteRecord: WasteRecord.schema,
  Coupon: Coupon.schema,
  Customer: Customer.schema,
  ShopSettings: ShopSettings.schema,
  Counter: Counter.schema,
  AuditLog: AuditLog.schema,
  SessionPresence: SessionPresence.schema,
};

class BranchDatabaseManager {
  constructor() {
    /** @type {Map<string, mongoose.Connection>} branchId -> connection */
    this.connections = new Map();
    /** @type {Map<string, Object>} branchId -> branch configuration cache */
    this.branchCache = new Map();
    this.lastCacheRefresh = 0;
    this.CACHE_TTL_MS = 60 * 1000; // 1 minute
  }

  /**
   * Refreshes the in-memory cache of active branches from the global database.
   */
  async refreshBranchCache() {
    try {
      const branches = await Branch.find({ status: 'ACTIVE' }).lean();
      this.branchCache.clear();
      for (const b of branches) {
        this.branchCache.set(b.branchId, b);
      }
      this.lastCacheRefresh = Date.now();
      return Array.from(this.branchCache.values());
    } catch (err) {
      logger.error('BRANCH_DB', `Failed to refresh branch cache: ${err.message}`);
      return Array.from(this.branchCache.values());
    }
  }

  /**
   * Retrieves all active branches.
   */
  async getActiveBranches() {
    if (Date.now() - this.lastCacheRefresh > this.CACHE_TTL_MS || this.branchCache.size === 0) {
      await this.refreshBranchCache();
    }
    return Array.from(this.branchCache.values());
  }

  /**
   * Retrieves branch configuration by branchId.
   */
  async getBranchConfig(branchId) {
    if (!branchId) return null;
    let branch = this.branchCache.get(branchId);
    if (!branch || Date.now() - this.lastCacheRefresh > this.CACHE_TTL_MS) {
      branch = await Branch.findOne({ branchId, status: 'ACTIVE' }).lean();
      if (branch) {
        this.branchCache.set(branchId, branch);
      }
    }
    return branch;
  }

  /**
   * Resolves or creates a connection for the specified branch.
   * Leverages mongoose connection pooling via useDb or createConnection.
   */
  async getBranchDb(branchId) {
    if (!branchId) {
      throw new Error('branchId is required to resolve database connection');
    }

    if (this.connections.has(branchId)) {
      const conn = this.connections.get(branchId);
      if (conn.readyState === 1 || conn.readyState === 2) {
        return conn;
      }
    }

    const branch = await this.getBranchConfig(branchId);
    if (!branch) {
      throw new Error(`Branch '${branchId}' not found or inactive`);
    }

    const dbIdentifier = branch.databaseIdentifier;
    if (!dbIdentifier) {
      throw new Error(`Database identifier not configured for branch '${branchId}'`);
    }

    logger.info('BRANCH_DB', `Resolving connection for branch: ${branchId} (${dbIdentifier})`);

    let conn;
    const baseUri = process.env.MONGODB_URI;

    // Check if custom Mongo URI is provided in env or branch record
    const customUri = process.env[`BRANCH_${branch.branchCode}_MONGODB_URI`];

    if (customUri) {
      conn = await mongoose.createConnection(customUri, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        maxPoolSize: 10,
        minPoolSize: 2,
        maxIdleTimeMS: 30000,
        retryWrites: true,
        retryReads: true,
      }).asPromise();
    } else {
      // Use existing primary cluster connection and switch/pool to the branch database
      conn = mongoose.connection.useDb(dbIdentifier, { useCache: true });
    }

    this.connections.set(branchId, conn);
    return conn;
  }

  /**
   * Retrieves a model compiled on the branch-specific database connection.
   */
  async getBranchModel(branchId, modelName) {
    const conn = await this.getBranchDb(branchId);

    // If model is already compiled on this connection, return it
    if (conn.models[modelName]) {
      return conn.models[modelName];
    }

    const schema = SCHEMAS[modelName];
    if (!schema) {
      throw new Error(`Unknown model '${modelName}' for branch database`);
    }

    // Compile model on connection
    const model = conn.model(modelName, schema);
    return model;
  }

  /**
   * Drops the dedicated database for a branch and removes its connection and cache.
   */
  async deleteBranchDb(branchId, databaseIdentifier) {
    if (!branchId || branchId === 'branch_001') {
      logger.warn('BRANCH_DB', `Cannot drop database for primary branch ${branchId}`);
      return;
    }

    let primaryDbName = 'nerocafe';
    try {
      const match = (process.env.MONGODB_URI || '').match(/\/([^/?]+)(\?|$)/);
      if (match && match[1]) primaryDbName = match[1];
    } catch {}

    const dbId = databaseIdentifier || `nerocafe_${branchId}`;

    // Critical guard: Never drop the shared or primary database!
    const protectedDbs = ['nerocafe', 'nerocafe_dev', 'admin', 'local', 'config', primaryDbName.toLowerCase()];
    const isSharedDb = protectedDbs.includes(dbId.toLowerCase());

    try {
      if (isSharedDb) {
        logger.warn('BRANCH_DB', `Branch '${branchId}' shares database '${dbId}'. Cleaning only branch-scoped data, preserving shared database.`);
        if (mongoose.connection && mongoose.connection.readyState === 1) {
          const collections = ['orders', 'customers', 'menuitems', 'inventoryitems', 'counters'];
          for (const colName of collections) {
            try {
              await mongoose.connection.collection(colName).deleteMany({ branchId });
            } catch {
              /* collection may not exist */
            }
          }
        }
      } else {
        logger.warn('BRANCH_DB', `Dropping dedicated isolated branch database: ${dbId} for branch ${branchId}`);
        // If connection exists in pool, drop database through it
        if (this.connections.has(branchId)) {
          const conn = this.connections.get(branchId);
          if (conn && conn.db) {
            await conn.db.dropDatabase();
          }
          if (conn && typeof conn.close === 'function') {
            await conn.close();
          }
          this.connections.delete(branchId);
        } else {
          // Open temporary connection to drop
          const tempConn = mongoose.connection.useDb(dbId, { useCache: false });
          if (tempConn && tempConn.db) {
            await tempConn.db.dropDatabase();
          }
        }
      }

      this.branchCache.delete(branchId);
      logger.success('BRANCH_DB', `Successfully cleaned data for branch '${branchId}' without affecting other branches.`);
    } catch (err) {
      logger.error('BRANCH_DB', `Failed to clean branch database ${branchId}: ${err.message}`);
    }
  }

  /**
   * Safely closes all branch connections during graceful shutdown.
   */
  async closeAll() {
    logger.info('BRANCH_DB', 'Closing all branch database connections...');
    for (const [branchId, conn] of this.connections.entries()) {
      try {
        if (conn && typeof conn.close === 'function') {
          await conn.close();
        }
      } catch (err) {
        logger.warn('BRANCH_DB', `Error closing connection for branch ${branchId}: ${err.message}`);
      }
    }
    this.connections.clear();
    this.branchCache.clear();
  }
}

export const branchDbManager = new BranchDatabaseManager();
export default branchDbManager;
