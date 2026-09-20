import { branchDbManager } from '../config/branchDbManager.js';
import { logger } from '../utils/logger.js';
import { AuditLog } from '../models/AuditLog.js';

/**
 * Default fallback branch for backward compatibility with existing clients.
 */
export const DEFAULT_BRANCH_ID = 'branch_001';

/**
 * Middleware that resolves and validates the branch context from request headers, query, or body.
 */
export async function resolveBranchContext(req, res, next) {
  try {
    const rawBranchId =
      req.headers['x-branch-id'] ||
      req.query.branchId ||
      req.body?.branchId ||
      DEFAULT_BRANCH_ID;

    const branchId = String(rawBranchId).trim();

    let branchConfig = await branchDbManager.getBranchConfig(branchId);

    // If requested branch is not found or inactive
    if (!branchConfig) {
      // If client explicitly requested an unknown branch, reject
      if (rawBranchId && rawBranchId !== DEFAULT_BRANCH_ID) {
        return res.status(404).json({
          error: `Branch '${rawBranchId}' not found or is currently inactive.`,
          code: 'BRANCH_NOT_FOUND',
        });
      }

      // If fallback branch was not found, attempt to fetch any active branch
      const activeBranches = await branchDbManager.getActiveBranches();
      if (activeBranches.length > 0) {
        branchConfig = activeBranches[0];
      } else {
        return res.status(503).json({
          error: 'No active NeroCafes branches are currently configured.',
          code: 'NO_ACTIVE_BRANCHES',
        });
      }
    }

    req.branchId = branchConfig.branchId;
    req.branch = branchConfig;
    req.branchConfig = branchConfig;

    // Helper bound to this request's branch context
    req.getBranchModel = (modelName) => branchDbManager.getBranchModel(req.branchId, modelName);

    next();
  } catch (error) {
    logger.error('BRANCH_CONTEXT', `Branch resolution error: ${error.message}`, { error });
    return res.status(500).json({ error: 'Failed to resolve branch context' });
  }
}

/**
 * Middleware that verifies whether the authenticated admin has authorization to access the current branch.
 * Enforces strict order isolation and multi-branch security.
 */
export function requireBranchAccess(req, res, next) {
  if (!req.admin) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  const role = req.admin.role || 'BRANCH_ADMIN';
  const adminBranchId = req.admin.branchId;
  const targetBranchId = req.branchId;

  // Super admin can access all branches
  if (role === 'SUPER_ADMIN' || role === 'PLATFORM_OPERATOR') {
    return next();
  }

  // Multi-branch regional manager check
  if (Array.isArray(req.admin.allowedBranches) && req.admin.allowedBranches.includes(targetBranchId)) {
    return next();
  }

  // Branch admin must match target branch exactly
  if (adminBranchId && adminBranchId === targetBranchId) {
    return next();
  }

  // If no branchId assigned to admin, default to branch_001 for legacy admins
  if (!adminBranchId && targetBranchId === DEFAULT_BRANCH_ID) {
    return next();
  }

  // Unauthorized cross-branch attempt detected
  logger.warn('SECURITY', `Cross-branch access denied: Admin '${req.admin.email}' (${adminBranchId || 'unassigned'}) attempted accessing branch '${targetBranchId}'`);

  AuditLog.create({
    action: 'CROSS_BRANCH_ACCESS_DENIED',
    userType: 'admin',
    actorName: req.admin.email,
    target: `Branch: ${targetBranchId}`,
    ip: req.headers['x-forwarded-for'] || req.ip || '',
    userAgent: req.headers['user-agent'] || '',
    path: req.originalUrl || req.path,
    method: req.method,
    status: 403,
    success: false,
    body: {
      adminId: req.admin._id,
      adminBranchId,
      targetBranchId,
    },
    timestamp: new Date(),
  }).catch(() => {});

  return res.status(403).json({
    error: `Access Denied: You do not have permission to manage branch '${targetBranchId}'.`,
    code: 'CROSS_BRANCH_FORBIDDEN',
  });
}
