import { Customer as GlobalCustomer } from '../models/Customer.js';
import { User } from '../models/User.js';
import { branchDbManager } from '../config/branchDbManager.js';
import { normalizePhone } from './phone.js';
import { logger } from './logger.js';

/**
 * Synchronizes a single User into the Customer CRM collection for a specific branch.
 * Creates or updates the Customer document linked to this User.
 */
export async function syncUserToCustomer(user, branchId = 'branch_001') {
  if (!user || !user._id) return null;

  try {
    let CustomerModel;
    try {
      CustomerModel = await branchDbManager.getBranchModel(branchId, 'Customer');
    } catch {
      CustomerModel = GlobalCustomer;
    }

    const rawPhone = user.phone || '';
    const normPhone = normalizePhone(rawPhone) || rawPhone || `user_${user._id}`;
    const userEmail = (user.email || '').trim().toLowerCase();
    const isSyntheticEmail = userEmail.endsWith('@customer.nerocafe.com');

    // 1. Find existing customer by userId in this branch
    let customer = await CustomerModel.findOne({ userId: user._id });

    // 2. If not found by userId, find by normalized phone or real email
    if (!customer && normPhone && !normPhone.startsWith('user_')) {
      customer = await CustomerModel.findOne({ phone: normPhone });
    }
    if (!customer && userEmail && !isSyntheticEmail) {
      customer = await CustomerModel.findOne({ email: userEmail });
    }

    if (customer) {
      let modified = false;
      if (!customer.userId || String(customer.userId) !== String(user._id)) {
        customer.userId = user._id;
        modified = true;
      }
      if (user.name && customer.name !== user.name) {
        customer.name = user.name;
        modified = true;
      }
      if (userEmail && !isSyntheticEmail && customer.email !== userEmail) {
        customer.email = userEmail;
        modified = true;
      }
      if (user.avatarUrl && customer.profileImage !== user.avatarUrl) {
        customer.profileImage = user.avatarUrl;
        modified = true;
      }
      if (normPhone && !normPhone.startsWith('user_') && customer.phone !== normPhone) {
        customer.phone = normPhone;
        modified = true;
      }
      if (modified) {
        await customer.save();
      }
      return customer;
    }

    // 3. Create a new Customer entry linked to this User in this branch
    customer = await CustomerModel.create({
      name: user.name || 'Registered Customer',
      phone: normPhone,
      email: isSyntheticEmail ? '' : userEmail,
      userId: user._id,
      countryCode: '91',
      address: user.address || '',
      profileImage: user.avatarUrl || '',
      orderCount: 0,
      totalSpending: 0,
      status: 'active',
    });

    logger.success('ADMIN', `Auto-synced new Customer from User account: ${user.name} (${user.email || user.phone}) for branch ${branchId}`);
    return customer;
  } catch (err) {
    logger.warn('ADMIN', `Failed to sync user to customer for branch ${branchId}: ${err.message}`, { error: err });
    return null;
  }
}

/**
 * Synchronizes all User documents in the database to Customer documents for a branch.
 * Called on GET /admin/customers and server boot to ensure zero missing customers.
 * @returns {Promise<number>} count of users processed
 */
export async function syncAllUsersToCustomers(branchId = 'branch_001') {
  try {
    const users = await User.find().lean();
    if (!users || !users.length) return 0;

    let count = 0;
    for (const u of users) {
      const result = await syncUserToCustomer(u, branchId);
      if (result) count++;
    }
    return count;
  } catch (err) {
    logger.warn('ADMIN', `Batch user-to-customer sync error for branch ${branchId}: ${err.message}`);
    return 0;
  }
}
