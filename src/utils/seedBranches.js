import mongoose from 'mongoose';
import { Branch } from '../models/Branch.js';
import { Order } from '../models/Order.js';
import { Admin } from '../models/Admin.js';
import { MenuItem } from '../models/MenuItem.js';
import { ShopSettings } from '../models/ShopSettings.js';
import { InventoryItem } from '../models/Inventory.js';
import { branchDbManager } from '../config/branchDbManager.js';
import { getPrimaryDatabaseName } from '../config/databaseName.js';
import { logger } from './logger.js';

export async function seedAndMigrateBranches() {
  try {
    // The primary branch must use the same database as the main connection.
    // A URI without a database segment connects to MongoDB's existing `test`
    // database; using a made-up name here would create a second database.
    const currentDbName = getPrimaryDatabaseName();

    logger.info('MIGRATION', `Ensuring primary branch registry on database: ${currentDbName}`);

    // 1. Ensure branch_001 (ISTTM Campus)
    let isttmBranch = await Branch.findOne({ branchId: 'branch_001' });
    if (!isttmBranch) {
      isttmBranch = await Branch.create({
        branchId: 'branch_001',
        branchCode: 'ISTTM',
        name: 'ISTTM Campus',
        displayName: 'NeroCafes — ISTTM Campus',
        address: 'ISTTM Business School, Hyderabad',
        city: 'Hyderabad',
        state: 'Telangana',
        country: 'India',
        latitude: 17.4486,
        longitude: 78.3908,
        serviceRadius: 5000,
        timezone: 'Asia/Kolkata',
        phone: '919100020345',
        email: 'nerocafes.isttm@gmail.com',
        openingHours: {
          open: '10:00',
          close: '22:00',
          days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
        },
        status: 'ACTIVE',
        databaseIdentifier: currentDbName,
        isDefault: true,
      });
      logger.success('MIGRATION', 'Registered primary branch: branch_001 (ISTTM Campus)');
    } else if (isttmBranch.databaseIdentifier !== currentDbName) {
      // Repair old deployments that registered the primary branch as
      // `nerocafe` even though their URI was using MongoDB's `test` database.
      isttmBranch.databaseIdentifier = currentDbName;
      isttmBranch.isDefault = true;
      await isttmBranch.save();
      logger.success('MIGRATION', `Primary branch now uses the existing database: ${currentDbName}`);
    }

    // 1b. Ensure branch_004 (Madhapur Branch)
    let madhapurBranch = await Branch.findOne({ branchId: 'branch_004' });
    if (!madhapurBranch) {
      madhapurBranch = await Branch.create({
        branchId: 'branch_004',
        branchCode: 'MDPR',
        name: 'Madhapur Branch',
        displayName: 'NeroCafes — Madhapur',
        address: 'Plot 42, Hitec City Main Road, Madhapur, Hyderabad',
        city: 'Hyderabad',
        state: 'Telangana',
        country: 'India',
        latitude: 17.4483,
        longitude: 78.3800,
        serviceRadius: 5000,
        timezone: 'Asia/Kolkata',
        phone: '919100020346',
        email: 'nerocafes.madhapur@gmail.com',
        openingHours: {
          open: '09:00',
          close: '23:00',
          days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
        },
        status: 'ACTIVE',
        databaseIdentifier: 'nerocafe_branch_004',
        isDefault: false,
      });
      logger.success('MIGRATION', 'Registered primary branch: branch_004 (Madhapur Branch)');
    }

    // 2. Remove branch_002 (Hitec City Hub) as requested
    const deletedHitec = await Branch.deleteMany({
      $or: [{ branchId: 'branch_002' }, { branchCode: 'HITEC' }],
    });
    if (deletedHitec.deletedCount > 0) {
      logger.info('MIGRATION', `Cleaned up removed branch_002 (Hitec City) records: ${deletedHitec.deletedCount}`);
    }

    // 3. Backfill existing orders with branch_001
    const unmigratedOrders = await Order.countDocuments({
      $or: [{ branchId: { $exists: false } }, { branchId: null }, { branchId: '' }, { branchId: 'branch_002' }],
    });

    if (unmigratedOrders > 0) {
      logger.info('MIGRATION', `Tagging ${unmigratedOrders} orders with branch_001...`);
      await Order.updateMany(
        { $or: [{ branchId: { $exists: false } }, { branchId: null }, { branchId: '' }, { branchId: 'branch_002' }] },
        { $set: { branchId: 'branch_001' } }
      );
      logger.success('MIGRATION', `Successfully backfilled ${unmigratedOrders} orders with branchId: branch_001`);
    }

    // 4. Ensure admin accounts have multi-branch fields
    const unmigratedAdmins = await Admin.countDocuments({
      $or: [{ role: { $exists: false } }, { branchId: { $exists: false } }, { branchId: 'branch_002' }],
    });

    if (unmigratedAdmins > 0) {
      logger.info('MIGRATION', `Updating roles for ${unmigratedAdmins} admin accounts...`);
      const admins = await Admin.find();
      for (let i = 0; i < admins.length; i++) {
        const adm = admins[i];
        if (!adm.role) {
          adm.role = i === 0 ? 'SUPER_ADMIN' : 'BRANCH_ADMIN';
        }
        if (!adm.branchId || adm.branchId === 'branch_002') {
          adm.branchId = 'branch_001';
        }
        if (!adm.allowedBranches || adm.allowedBranches.length === 0) {
          adm.allowedBranches = ['branch_001'];
        }
        await adm.save();
      }
      logger.success('MIGRATION', 'Admin accounts updated with multi-branch roles');
    }

    // The platform owner always remains on the original primary branch. Do not
    // turn this account into a newly provisioned branch-admin account.
    const owner = await Admin.findOne({ email: 'nerocafes14@gmail.com' });
    if (owner) {
      const needsOwnerUpdate =
        owner.role !== 'SUPER_ADMIN' ||
        owner.branchId !== 'branch_001' ||
        !owner.allowedBranches?.includes('branch_001');
      if (needsOwnerUpdate) {
        owner.role = 'SUPER_ADMIN';
        owner.branchId = 'branch_001';
        owner.allowedBranches = Array.from(new Set([...(owner.allowedBranches || []), 'branch_001']));
        await owner.save();
        logger.success('MIGRATION', 'Kept nerocafes14@gmail.com on the original primary branch');
      }
    }

    // Refresh memory cache
    await branchDbManager.refreshBranchCache();
    logger.success('MIGRATION', 'Multi-branch migration and cache sync complete.');
  } catch (error) {
    logger.error('MIGRATION', `Multi-branch migration encountered error: ${error.message}`, { error });
  }
}
