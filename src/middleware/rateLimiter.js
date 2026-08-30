import rateLimit from 'express-rate-limit';

/**
 * Customer Auth endpoints (login, OTP, signup, verify)
 * Generous limits (300 req / 15 min per IP) so dozens of customers
 * sharing the same Cafe WiFi / NAT IP can all authenticate seamlessly.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts from this network. Please try again in a few minutes.' },
  skipSuccessfulRequests: true,
});

/**
 * Admin Auth endpoints (dedicated protection for admin panel)
 * 50 attempts per 15 minutes per IP.
 */
export const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin login attempts. Please try again later.' },
  skipSuccessfulRequests: true,
});

/**
 * General API rate limit – 25,000 req / 15 min per IP.
 * Exempts high-frequency system/presence/telemetry/health routes
 * so active cafe browsing, menu polling, and heartbeats never get throttled.
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Please slow down.' },
  skip: (req) => {
    const url = (req.originalUrl || req.url || req.path || '').toLowerCase();
    // Exempt presence/heartbeats, health, liveness, sockets, static assets, and command center
    if (url.includes('/presence') || url.includes('/heartbeat')) return true;
    if (url.includes('/health') || url.includes('/live') || url.includes('/ready')) return true;
    if (url.includes('/command-center')) return true;
    if (url.includes('/menu') && req.method === 'GET') return true;
    if (url.includes('/offers') && req.method === 'GET') return true;
    if (url.includes('/public') && req.method === 'GET') return true;
    return false;
  },
});

/**
 * Payment endpoints – 200 req / 15 min per IP.
 */
export const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment requests. Please try again later.' },
});

/**
 * Admin dashboard endpoints – 2,500 req / 15 min per IP.
 */
export const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests. Please slow down.' },
});

