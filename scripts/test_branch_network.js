import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

if (fs.existsSync('./.env.dev')) {
  dotenv.config({ path: './.env.dev' });
} else {
  dotenv.config({ path: './.env' });
}

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'change-me-admin-jwt-secret';
const API_URL = 'http://localhost:5001/api';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { Admin } = await import('../src/models/Admin.js');

  // Fetch or configure real admins from DB
  const branchAdmin = await Admin.findOne({ email: 'nerocafes14@gmail.com' }).lean();
  let superAdmin = await Admin.findOne({ email: 'admin@nerocafe.com' });
  if (superAdmin) {
    superAdmin.role = 'SUPER_ADMIN';
    superAdmin.allowedBranches = ['*'];
    await superAdmin.save();
  }

  // Create temporary authorized branch_003 to test cross-branch security check (403 Forbidden)
  const { Branch } = await import('../src/models/Branch.js');
  const { branchDbManager } = await import('../src/config/branchDbManager.js');

  await Branch.deleteMany({ branchId: 'branch_003' });
  await Branch.create({
    branchId: 'branch_003',
    branchCode: 'TEST03',
    name: 'Gachibowli Test Branch',
    displayName: 'NeroCafes — Gachibowli',
    address: 'Gachibowli, Hyderabad',
    latitude: 17.44,
    longitude: 78.38,
    databaseIdentifier: 'nerocafes_branch_003',
    status: 'ACTIVE',
  });
  await branchDbManager.refreshBranchCache();

  // Tokens
  const branchAdminToken = jwt.sign(
    { sub: branchAdmin._id.toString(), type: 'access', v: branchAdmin.tokenVersion || 0 },
    ADMIN_JWT_SECRET,
    { expiresIn: '1h' }
  );

  const superAdminToken = jwt.sign(
    { sub: superAdmin._id.toString(), type: 'access', v: superAdmin.tokenVersion || 0 },
    ADMIN_JWT_SECRET,
    { expiresIn: '1h' }
  );

  const testCases = [
    // 1. Branch 001 admin operating on assigned branch_001 (Expected: 200 OK)
    {
      role: branchAdmin.role || 'BRANCH_ADMIN',
      adminBranchId: branchAdmin.branchId || 'branch_001',
      requestedBranch: 'branch_001',
      url: `${API_URL}/admin/stats`,
      token: branchAdminToken,
      expected: 200,
    },
    {
      role: branchAdmin.role || 'BRANCH_ADMIN',
      adminBranchId: branchAdmin.branchId || 'branch_001',
      requestedBranch: 'branch_001',
      url: `${API_URL}/admin/orders`,
      token: branchAdminToken,
      expected: 200,
    },
    {
      role: branchAdmin.role || 'BRANCH_ADMIN',
      adminBranchId: branchAdmin.branchId || 'branch_001',
      requestedBranch: 'branch_001',
      url: `${API_URL}/menu/admin/all`,
      token: branchAdminToken,
      expected: 200,
    },
    {
      role: branchAdmin.role || 'BRANCH_ADMIN',
      adminBranchId: branchAdmin.branchId || 'branch_001',
      requestedBranch: 'branch_001',
      url: `${API_URL}/admin/branches`,
      token: branchAdminToken,
      expected: 200,
    },

    // 2. Branch 001 admin attempting to access branch_003 (Expected: 403 Forbidden - Security check)
    {
      role: branchAdmin.role || 'BRANCH_ADMIN',
      adminBranchId: branchAdmin.branchId || 'branch_001',
      requestedBranch: 'branch_003',
      url: `${API_URL}/admin/stats`,
      token: branchAdminToken,
      expected: 403,
    },
    {
      role: branchAdmin.role || 'BRANCH_ADMIN',
      adminBranchId: branchAdmin.branchId || 'branch_001',
      requestedBranch: 'branch_003',
      url: `${API_URL}/admin/orders`,
      token: branchAdminToken,
      expected: 403,
    },
    {
      role: branchAdmin.role || 'BRANCH_ADMIN',
      adminBranchId: branchAdmin.branchId || 'branch_001',
      requestedBranch: 'branch_003',
      url: `${API_URL}/menu/admin/all`,
      token: branchAdminToken,
      expected: 403,
    },

    // 3. SUPER_ADMIN accessing branch_001 and branch_003 (Expected: 200 OK)
    {
      role: 'SUPER_ADMIN',
      adminBranchId: 'branch_001',
      requestedBranch: 'branch_001',
      url: `${API_URL}/admin/stats`,
      token: superAdminToken,
      expected: 200,
    },
    {
      role: 'SUPER_ADMIN',
      adminBranchId: 'branch_001',
      requestedBranch: 'branch_003',
      url: `${API_URL}/admin/stats`,
      token: superAdminToken,
      expected: 200,
    },
  ];

  const results = [];

  for (const tc of testCases) {
    try {
      const res = await fetch(tc.url, {
        headers: {
          Authorization: `Bearer ${tc.token}`,
          'x-branch-id': tc.requestedBranch,
        },
      });
      results.push({
        'Admin Role': tc.role,
        'Admin BranchId': tc.adminBranchId,
        'Requested BranchId': tc.requestedBranch,
        'Final x-branch-id': tc.requestedBranch,
        'Endpoint': tc.url.replace(API_URL, ''),
        'HTTP Status': res.status,
        'Status Text': res.statusText,
      });
    } catch (err) {
      results.push({
        'Admin Role': tc.role,
        'Admin BranchId': tc.adminBranchId,
        'Requested BranchId': tc.requestedBranch,
        'Final x-branch-id': tc.requestedBranch,
        'Endpoint': tc.url.replace(API_URL, ''),
        'HTTP Status': 'ERROR: ' + err.message,
        'Status Text': 'FAIL',
      });
    }
  }

  console.log('\n================ ACTUAL NETWORK TEST RESULTS ================');
  console.table(results);

  // Cleanup temporary test branch
  await Branch.deleteMany({ branchId: 'branch_003' });
  await branchDbManager.refreshBranchCache();

  await mongoose.disconnect();
}

run().catch(console.error);
