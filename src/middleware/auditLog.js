import { AuditLog } from '../models/AuditLog.js';

/**
 * Audit Log Middleware
 * Logs important actions for security and compliance
 */

export function auditLog(action) {
  return async (req, res, next) => {
    // Store original json method
    const originalJson = res.json;

    // Override json method to log response
    res.json = function(data) {
      // Log the action
      logAudit(req, action, data).catch(err => {
        console.error('[AuditLog] Failed to log:', err);
      });

      // Call original json method
      return originalJson.call(this, data);
    };

    next();
  };
}

async function logAudit(req, action, responseData) {
  try {
    const userId = req.user?._id || req.admin?._id || null;
    const userType = req.user ? 'user' : req.admin ? 'admin' : 'system';
    
    const logEntry = {
      action,
      userId,
      userType,
      ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      method: req.method,
      path: req.path,
      body: sanitizeBody(req.body),
      query: req.query,
      status: responseData?.status || res?.statusCode,
      success: res.statusCode < 400,
      timestamp: new Date(),
    };

    await AuditLog.create(logEntry);
  } catch (error) {
    console.error('[AuditLog] Failed to create audit log:', error);
  }
}

function sanitizeBody(body) {
  if (!body) return null;
  
  const sensitiveFields = ['password', 'token', 'refreshToken', 'secret', 'apiKey'];
  const sanitized = { ...body };
  
  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  }
  
  return sanitized;
}

/**
 * Get audit logs for admin
 */
export async function getAuditLogs(filters = {}, limit = 100) {
  try {
    const query = {};
    
    if (filters.userId) query.userId = filters.userId;
    if (filters.userType) query.userType = filters.userType;
    if (filters.action) query.action = filters.action;
    if (filters.startDate) query.timestamp = { $gte: new Date(filters.startDate) };
    if (filters.endDate) {
      if (query.timestamp) {
        query.timestamp.$lte = new Date(filters.endDate);
      } else {
        query.timestamp = { $lte: new Date(filters.endDate) };
      }
    }
    
    const logs = await AuditLog.find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
    
    return logs;
  } catch (error) {
    console.error('[AuditLog] Failed to get logs:', error);
    return [];
  }
}

export default auditLog;
