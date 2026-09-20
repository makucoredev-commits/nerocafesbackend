import crypto from 'crypto';
import { logger } from './logger.js';

// In-memory registry of passkey enrollment requests (with 15 min expiration)
const enrollmentRequests = new Map();

/**
 * Clean up expired requests older than 15 minutes
 */
function cleanupExpired() {
  const now = Date.now();
  for (const [id, req] of enrollmentRequests.entries()) {
    if (req.expiresAt && req.expiresAt < now) {
      enrollmentRequests.delete(id);
    }
  }
}
setInterval(cleanupExpired, 60000);

export const passkeyEnrollmentManager = {
  /**
   * Admin on website creates a request to add passkey
   */
  createRequest({ adminId, email, name, label }) {
    cleanupExpired();
    // Check if a pending or approved request already exists for this admin
    for (const [id, existing] of enrollmentRequests.entries()) {
      if (existing.adminId === String(adminId) && existing.status === 'PENDING') {
        return existing;
      }
    }

    const requestId = 'pkr_' + crypto.randomBytes(8).toString('hex');
    const req = {
      requestId,
      adminId: String(adminId),
      email: (email || '').toLowerCase().trim(),
      name: name || 'Admin User',
      label: label || 'Windows Hello / PC Passkey',
      status: 'PENDING', // 'PENDING' | 'APPROVED' | 'REJECTED' | 'CONSUMED'
      createdAt: Date.now(),
      expiresAt: Date.now() + 15 * 60 * 1000, // 15 minutes
      approvedAt: null,
      enrollmentToken: null,
    };
    enrollmentRequests.set(requestId, req);
    logger.info('PASSKEY', `New passkey enrollment request created: ${requestId} for ${req.email}`);
    return req;
  },

  /**
   * Command Center operator triggers a pre-approved passkey prompt for an admin
   */
  createOperatorApprovedWindow({ adminId, email, name, label }) {
    cleanupExpired();
    const requestId = 'pkr_' + crypto.randomBytes(8).toString('hex');
    const enrollmentToken = 'pkt_' + crypto.randomBytes(16).toString('hex');
    const req = {
      requestId,
      adminId: String(adminId),
      email: (email || '').toLowerCase().trim(),
      name: name || 'Admin User',
      label: label || 'Operator Authorized Passkey',
      status: 'APPROVED',
      createdAt: Date.now(),
      approvedAt: Date.now(),
      expiresAt: Date.now() + 15 * 60 * 1000,
      approvedBy: 'Terminal Command Center',
      enrollmentToken,
    };
    enrollmentRequests.set(requestId, req);
    logger.info('PASSKEY', `Operator pre-approved passkey enrollment window: ${requestId} for ${req.email}`);
    return req;
  },

  /**
   * List all pending requests for the Command Center
   */
  getPendingRequests() {
    cleanupExpired();
    return Array.from(enrollmentRequests.values()).filter((r) => r.status === 'PENDING');
  },

  /**
   * Get request by ID
   */
  getRequest(requestId) {
    return enrollmentRequests.get(requestId) || null;
  },

  /**
   * Command Center operator approves / accepts a passkey request
   */
  approveRequest(requestId, approvedBy = 'Terminal Command Center') {
    const req = enrollmentRequests.get(requestId);
    if (!req) return { ok: false, error: 'Request not found or expired' };
    if (req.status !== 'PENDING') return { ok: false, error: `Request already ${req.status}` };

    const enrollmentToken = 'pkt_' + crypto.randomBytes(16).toString('hex');
    req.status = 'APPROVED';
    req.approvedAt = Date.now();
    req.approvedBy = approvedBy;
    req.enrollmentToken = enrollmentToken;
    req.expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes to finish registering

    logger.success('PASSKEY', `Passkey request ${requestId} ACCEPTED by ${approvedBy} for ${req.email}`);
    return { ok: true, request: req, enrollmentToken };
  },

  /**
   * Command Center operator rejects a passkey request
   */
  rejectRequest(requestId, rejectedBy = 'Terminal Command Center') {
    const req = enrollmentRequests.get(requestId);
    if (!req) return { ok: false, error: 'Request not found or expired' };

    req.status = 'REJECTED';
    req.rejectedAt = Date.now();
    req.rejectedBy = rejectedBy;

    logger.warn('PASSKEY', `Passkey request ${requestId} REJECTED by ${rejectedBy} for ${req.email}`);
    return { ok: true, request: req };
  },

  /**
   * Check if an admin has any approved request / token available
   */
  getApprovedTokenForAdmin(adminId) {
    cleanupExpired();
    const strId = String(adminId);
    for (const req of enrollmentRequests.values()) {
      if (req.adminId === strId && req.status === 'APPROVED' && req.expiresAt > Date.now()) {
        return req;
      }
    }
    return null;
  },

  /**
   * Verify and consume token when passkey is successfully registered
   */
  verifyAndConsume(adminId, enrollmentToken) {
    cleanupExpired();
    const strId = String(adminId);

    // If specific token provided
    if (enrollmentToken) {
      for (const [id, req] of enrollmentRequests.entries()) {
        if (
          req.adminId === strId &&
          req.status === 'APPROVED' &&
          req.enrollmentToken === enrollmentToken &&
          req.expiresAt > Date.now()
        ) {
          req.status = 'CONSUMED';
          return true;
        }
      }
    }

    // Fallback: check any active approved request for this admin
    for (const [id, req] of enrollmentRequests.entries()) {
      if (req.adminId === strId && req.status === 'APPROVED' && req.expiresAt > Date.now()) {
        req.status = 'CONSUMED';
        return true;
      }
    }

    return false;
  },
};
