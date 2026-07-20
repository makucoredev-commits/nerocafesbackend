import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './utils/logger.js';
import { requestIdMiddleware } from './middleware/requestId.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Environment loading logic:
// - If .env exists, load it (supports manual VPS/AWS deployments with local config)
// - If .env.dev exists and we are not in production, load it
// - Otherwise, fallback to system environment variables (like Render or containerized environments)
const nodeEnv = process.env.NODE_ENV || 'development';
const envPath = path.resolve(__dirname, '../.env');
const devEnvPath = path.resolve(__dirname, '../.env.dev');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  logger.info('SECURITY', `Loaded .env (${nodeEnv} mode)`);
} else if (nodeEnv !== 'production' && fs.existsSync(devEnvPath)) {
  dotenv.config({ path: devEnvPath });
  logger.info('SECURITY', 'Loaded .env.dev for development');
} else {
  logger.info('SECURITY', `Using system/process environment variables (${nodeEnv} mode)`);
}

// ============================================
// STARTUP VALIDATION
// ============================================

function validateEnvironment() {
  const isProduction = nodeEnv === 'production';
  const requiredVars = ['MONGODB_URI', 'JWT_SECRET', 'ADMIN_JWT_SECRET', 'CLIENT_ORIGIN'];
  const missing = [];

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  }

  if (missing.length > 0) {
    logger.fatal('SECURITY', `Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Razorpay key validation
  const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
  if (razorpayKeyId) {
    const isTestKey = razorpayKeyId.startsWith('rzp_test_');
    const isLiveKey = razorpayKeyId.startsWith('rzp_live_');

    if (isProduction && isTestKey) {
      logger.warn('PAYMENTS', 'Production environment is using Razorpay TEST keys.');
    } else if (!isProduction && isLiveKey) {
      logger.warn('PAYMENTS', 'Development environment is using Razorpay LIVE keys.');
    }
  }

  // Extract database name from MONGODB_URI
  const mongoUri = process.env.MONGODB_URI;
  let dbName = 'unknown';
  try {
    const match = mongoUri.match(/\/([^/?]+)(\?|$)/);
    if (match) {
      dbName = match[1];
    }
  } catch (e) {
    dbName = 'could not parse';
  }

  // Log environment configuration
  logger.info('SECURITY', `Environment loaded: ${nodeEnv.toUpperCase()} | DB: ${dbName} | Port: ${process.env.PORT || 5000}`);
}

validateEnvironment();

import express from 'express';
import cors from 'cors';
import compression from 'compression';

// Security and Socket setup
import helmet from 'helmet';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { connectDB } from './config/db.js';
import { sanitizeMongo, xssSanitize } from './middleware/sanitize.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import authRoutes from './routes/authRoutes.js';
import menuRoutes from './routes/menuRoutes.js';
import orderRoutes from './routes/orderRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import publicRoutes from './routes/publicRoutes.js';
import razorpayRoutes from './routes/razorpayRoutes.js';
import pushRoutes from './routes/pushRoutes.js';
import couponRoutes from './routes/couponRoutes.js';
import inventoryRoutes from './routes/inventoryRoutes.js';
import kitchenRoutes from './routes/kitchenRoutes.js';
import { getETAEngine } from './services/etaEngine.js';
import { getHealthMonitor } from './utils/healthMonitor.js';
import { migrateMenuDietaryCategories } from './utils/dietaryCategoryMigration.js';
import { AuditLog } from './models/AuditLog.js';



/** Allowed CORS origins – production-locked on deploy. */
const corsOrigins = [
  process.env.CLIENT_ORIGIN,
  'https://nerocafes.netlify.app',
  'https://nerocafea.netlify.app',
].filter(Boolean);

if (process.env.NODE_ENV !== 'production') {
  corsOrigins.push('http://localhost:5173', 'http://127.0.0.1:5173');
}

const app = express();
app.use(requestIdMiddleware);
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: corsOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

app.set('io', io);

// Initialize ETA Engine
const etaEngine = getETAEngine(io);
app.set('etaEngine', etaEngine);

io.on('connection', (socket) => {
  logger.info('SOCKET', `Socket Connected: ${socket.id}`);

  socket.on('subscribe:order', (orderId) => {
    if (orderId) {
      socket.join(`order:${orderId}`);
      logger.info('SOCKET', `Room Joined: ${socket.id} joined order room: ${orderId}`);
    }
  });
  socket.on('unsubscribe:order', (orderId) => {
    if (orderId) {
      socket.leave(`order:${orderId}`);
      logger.info('SOCKET', `Room Left: ${socket.id} left order room: ${orderId}`);
    }
  });

  socket.on('subscribe:customer', (customerId) => {
    if (customerId) {
      socket.join(`customer:${customerId}`);
      logger.info('SOCKET', `Room Joined: ${socket.id} joined customer room: ${customerId}`);
    }
  });
  socket.on('unsubscribe:customer', (customerId) => {
    if (customerId) {
      socket.leave(`customer:${customerId}`);
      logger.info('SOCKET', `Room Left: ${socket.id} left customer room: ${customerId}`);
    }
  });

  // User-specific rooms for order notifications
  socket.on('subscribe:user', (userId) => {
    if (userId) {
      socket.join(`user:${userId}`);
      logger.info('SOCKET', `Room Joined: ${socket.id} joined user room: ${userId}`);
    }
  });
  socket.on('unsubscribe:user', (userId) => {
    if (userId) {
      socket.leave(`user:${userId}`);
      logger.info('SOCKET', `Room Left: ${socket.id} left user room: ${userId}`);
    }
  });

  // Kitchen room for live updates
  socket.on('subscribe:kitchen', () => {
    socket.join('kitchen');
    logger.info('SOCKET', `Room Joined: ${socket.id} joined kitchen room`);
  });
  socket.on('unsubscribe:kitchen', () => {
    socket.leave('kitchen');
    logger.info('SOCKET', `Room Left: ${socket.id} left kitchen room`);
  });

  // Admin room for dashboard updates
  socket.on('subscribe:admin', () => {
    socket.join('admin');
    logger.info('SOCKET', `Room Joined: ${socket.id} joined admin room`);
  });
  socket.on('unsubscribe:admin', () => {
    socket.leave('admin');
    logger.info('SOCKET', `Room Left: ${socket.id} left admin room`);
  });

  // Cleanup on disconnect
  socket.on('disconnect', (reason) => {
    logger.info('SOCKET', `Socket Disconnected: ${socket.id}, reason: ${reason}`);
  });

  socket.on('error', (error) => {
    logger.error('SOCKET', `Socket error for ${socket.id}`, { error });
  });

  socket.on('customer:device_alert:ack', async (payload) => {
    if (!payload?.orderId || !payload?.customerId) return;
    io.to('admin').emit('customer:device_alert:ack', payload);

    try {
      await AuditLog.findOneAndUpdate(
        {
          action: 'CUSTOMER_VIBRATION',
          'body.orderId': payload.orderId,
          'body.customerId': payload.customerId,
        },
        {
          $set: {
            'body.acknowledgementReceived': true,
            'body.vibrationSupported': Boolean(payload.vibrationSupported),
            'body.vibrationEnabled': Boolean(payload.vibrationEnabled),
            'body.notificationPermission': payload.notificationPermission || 'default',
            'body.soundPlayed': Boolean(payload.soundPlayed),
            'body.result': payload.received ? 'acknowledged' : 'not_acknowledged',
            'body.acknowledgedAt': new Date(payload.timestamp || Date.now()),
          },
        },
        { sort: { timestamp: -1 } }
      );
    } catch (error) {
      logger.error('SOCKET', 'Failed to update customer alert audit', { error });
    }

    logger.info('SOCKET', `Device alert acknowledgement relayed to admin: ${payload.orderId}`);
  });
});

// Note: Obsolete custom console request logger removed since requestIdMiddleware provides standard logging.

/* ── Security middleware (applied first) ───────────────────────── */
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false, // Let Netlify handle CSP via _headers
  hsts: process.env.NODE_ENV === 'production' ? {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  } : false,
  noSniff: true,
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
  })
);

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const elapsed = Date.now() - startedAt;
    const healthMonitor = getHealthMonitor();
    healthMonitor.recordAPIRequest(elapsed, res.statusCode >= 400);
  });
  next();
});

/* Response compression */
app.use(compression());

/* Body parsing with size limit to prevent payload attacks */
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

/* Sanitise inputs — NoSQL injection + XSS */
app.use(sanitizeMongo);
app.use(xssSanitize);

/* Global rate limiter */
app.use('/api', apiLimiter);

/* ── HTTPS enforcement in production ───────────────────────────── */
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https' && !req.secure) {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

/* ── Static files ──────────────────────────────────────────────── */
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

/* ── API routes ────────────────────────────────────────────────── */
app.use('/api/auth', authRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/razorpay', razorpayRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/admin/coupons', couponRoutes);
app.use('/api/admin/inventory', inventoryRoutes);
app.use('/api/kitchen', kitchenRoutes);

/* ── Environment validation ───────────────────────────────────── */
app.use((req, res, next) => {
  const requiredEnvVars = ['MONGODB_URI', 'JWT_SECRET', 'ADMIN_JWT_SECRET'];
  const missing = requiredEnvVars.filter(varName => !process.env[varName]);
  
  if (missing.length > 0 && process.env.NODE_ENV === 'production') {
    logger.error('SECURITY', `Missing required environment variables in production: ${missing.join(', ')}`);
    return res.status(500).json({ error: 'Server configuration error' });
  }
  
  next();
});

/* ── Global error handler ───────────────────────────────────────── */
app.use((err, req, res, next) => {
  logger.error('API', `Internal Server Error: ${err.message}`, { error: err });

  // Handle specific error types
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation error',
      details: err.message
    });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({
      error: 'Invalid ID format'
    });
  }

  if (err.code === 11000) {
    return res.status(409).json({
      error: 'Duplicate entry',
      field: Object.keys(err.keyPattern || {})[0]
    });
  }

  // Default error response
  const statusCode = err.statusCode || 500;
  const isDevelopment = process.env.NODE_ENV !== 'production';

  res.status(statusCode).json({
    error: err.message || 'Internal server error',
    ...(isDevelopment && { stack: err.stack })
  });
});

/* ── 404 handler ─────────────────────────────────────────────────── */
app.use((req, res) => {
  logger.warn('API', `Route not found: ${req.method} ${req.url}`);
  res.status(404).json({
    error: 'Route not found',
    path: req.url,
    method: req.method
  });
});

app.get('/health', (_req, res) => {
  const healthMonitor = getHealthMonitor();
  res.json({
    ok: true,
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    metrics: healthMonitor.getHealthStatus(),
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// System health monitoring endpoint
app.get('/api/admin/system-health', (req, res) => {
  try {
    const healthMonitor = getHealthMonitor();
    const healthStatus = healthMonitor.getHealthStatus();
    res.json(healthStatus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 5000;

logger.info('SECURITY', 'Server Starting...', { nodeVersion: process.version });

connectDB()
  .then(async () => {
    await migrateMenuDietaryCategories();
    // Initialize ETA Engine with existing orders
    await etaEngine.initialize();
    logger.success('ETA_ENGINE', 'ETA Engine initialized successfully');
    
    httpServer.listen(PORT, '0.0.0.0', () => {
      logger.success('API', `Server Ready. NeroCafe API listening on port ${PORT}`, {
        clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
      });
    });
  })
  .catch((err) => {
    logger.fatal('SECURITY', 'Database connection or initialization failed', { error: err });
    process.exit(1);
  });
