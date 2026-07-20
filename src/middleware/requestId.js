import { logStorage, logger } from '../utils/logger.js';

/**
 * Generate a short random Request ID
 */
function generateRequestId() {
  return Math.random().toString(16).substring(2, 8);
}

/**
 * Request ID and execution tracing middleware
 */
export function requestIdMiddleware(req, res, next) {
  // Grab header correlation id if provided, or generate a fresh one
  const requestId = req.headers['x-request-id'] || generateRequestId();
  res.setHeader('X-Request-ID', requestId);

  // Context record mapping to store
  const context = {
    requestId,
    method: req.method,
    url: req.originalUrl || req.url,
    startTime: Date.now(),
    userId: null,
  };

  // Run downstream routes inside this context scope
  logStorage.run(context, () => {
    logger.info('API', `Request Received: ${req.method} ${context.url}`, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.on('finish', () => {
      const elapsed = Date.now() - context.startTime;
      const status = res.statusCode;
      const msg = `Request Completed: ${req.method} ${context.url} ${status} (${elapsed}ms)`;

      if (status >= 500) {
        logger.error('API', msg, { status, elapsed });
      } else if (status >= 400) {
        logger.warn('API', msg, { status, elapsed });
      } else {
        logger.success('API', msg, { status, elapsed });
      }
    });

    next();
  });
}
