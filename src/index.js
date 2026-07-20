/**
 * NeroCafe API Server
 * Enterprise-grade production entry point
 * 
 * Features:
 * - Structured logging with request tracing
 * - Graceful shutdown handling
 * - Health/readiness/live endpoints
 * - Request timing and metrics
 * - PM2/Nginx compatibility
 * - Trust proxy configuration
 * - Comprehensive security middleware
 * - Socket.IO real-time communication
 * - ETA Engine for order management
 * - Environment validation
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server } from 'socket.io';

import { logger } from './utils/logger.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { sanitizeMongo, xssSanitize } from './middleware/sanitize.js';
import { apiLimiter } from './middleware/rateLimiter.js';

import { connectDB } from './config/db.js';
import { getETAEngine } from './services/etaEngine.js';
import { getHealthMonitor } from './utils/healthMonitor.js';
import { migrateMenuDietaryCategories } from './utils/dietaryCategoryMigration.js';
import { AuditLog } from './models/AuditLog.js';

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

// ============================================================================
// CONFIGURATION
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const TRUST_PROXY = Number(process.env.TRUST_PROXY || 1);

// ============================================================================
// ENVIRONMENT LOADING
// ============================================================================

function loadEnvironment() {
  const envPath = path.resolve(__dirname, '../.env');
  const devEnvPath = path.resolve(__dirname, '../.env.dev');

  // Determine environment if not explicitly set
  if (!process.env.NODE_ENV) {
    if (fs.existsSync(envPath)) {
      process.env.NODE_ENV = 'production';
    } else if (fs.existsSync(devEnvPath)) {
      process.env.NODE_ENV = 'development';
    } else {
      process.env.NODE_ENV = 'production';
    }
  }

  const nodeEnv = process.env.NODE_ENV;

  // Load appropriate environment file
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    logger.info('ENV', `Loaded .env (${nodeEnv} mode)`);
  } else if (nodeEnv !== 'production' && fs.existsSync(devEnvPath)) {
    dotenv.config({ path: devEnvPath });
    logger.info('ENV', 'Loaded .env.dev for development');
  } else {
    logger.info('ENV', `Using system environment variables (${nodeEnv} mode)`);
  }

  return nodeEnv;
}

const nodeEnv = loadEnvironment();

// ============================================================================
// ENVIRONMENT VALIDATION
// ============================================================================

function validateEnvironment() {
  const isProduction = nodeEnv === 'production';
  const requiredVars = ['MONGODB_URI', 'JWT_SECRET', 'ADMIN_JWT_SECRET', 'CLIENT_ORIGIN'];
  const missing = requiredVars.filter(varName => !process.env[varName]);

  if (missing.length > 0) {
    logger.fatal('ENV', `Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Razorpay key validation
  const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
  if (razorpayKeyId) {
    const isTestKey = razorpayKeyId.startsWith('rzp_test_');
    const isLiveKey = razorpayKeyId.startsWith('rzp_live_');

    if (isProduction && isTestKey) {
      logger.warn('PAYMENTS', 'Production environment is using Razorpay TEST keys');
    } else if (!isProduction && isLiveKey) {
      logger.warn('PAYMENTS', 'Development environment is using Razorpay LIVE keys');
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

  logger.info('ENV', `Environment: ${nodeEnv.toUpperCase()} | DB: ${dbName} | Port: ${PORT}`);
}

validateEnvironment();

// ============================================================================
// CORS CONFIGURATION
// ============================================================================

function getCorsOrigins() {
  const origins = [
    process.env.CLIENT_ORIGIN,
    'https://nerocafes.netlify.app',
    'https://nerocafea.netlify.app',
  ].filter(Boolean);

  if (nodeEnv !== 'production') {
    origins.push('http://localhost:5173', 'http://127.0.0.1:5173');
  }

  return origins;
}

const corsOrigins = getCorsOrigins();

// ============================================================================
// EXPRESS APP INITIALIZATION
// ============================================================================

const app = express();
const httpServer = createServer(app);

// Trust proxy for PM2/Nginx deployments
app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');

// ============================================================================
// SOCKET.IO INITIALIZATION
// ============================================================================

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

app.set('io', io);

// ============================================================================
// ETA ENGINE INITIALIZATION
// ============================================================================

const etaEngine = getETAEngine(io);
app.set('etaEngine', etaEngine);

// ============================================================================
// SOCKET.IO EVENT HANDLERS
// ============================================================================

function setupSocketHandlers() {
  io.on('connection', (socket) => {
    logger.info('SOCKET', `Connected: ${socket.id}`);

    // Order subscription
    socket.on('subscribe:order', (orderId) => {
      if (orderId) {
        socket.join(`order:${orderId}`);
        logger.info('SOCKET', `Room joined: ${socket.id} → order:${orderId}`);
      }
    });

    socket.on('unsubscribe:order', (orderId) => {
      if (orderId) {
        socket.leave(`order:${orderId}`);
        logger.info('SOCKET', `Room left: ${socket.id} ← order:${orderId}`);
      }
    });

    // Customer subscription
    socket.on('subscribe:customer', (customerId) => {
      if (customerId) {
        socket.join(`customer:${customerId}`);
        logger.info('SOCKET', `Room joined: ${socket.id} → customer:${customerId}`);
      }
    });

    socket.on('unsubscribe:customer', (customerId) => {
      if (customerId) {
        socket.leave(`customer:${customerId}`);
        logger.info('SOCKET', `Room left: ${socket.id} ← customer:${customerId}`);
      }
    });

    // User subscription
    socket.on('subscribe:user', (userId) => {
      if (userId) {
        socket.join(`user:${userId}`);
        logger.info('SOCKET', `Room joined: ${socket.id} → user:${userId}`);
      }
    });

    socket.on('unsubscribe:user', (userId) => {
      if (userId) {
        socket.leave(`user:${userId}`);
        logger.info('SOCKET', `Room left: ${socket.id} ← user:${userId}`);
      }
    });

    // Kitchen subscription
    socket.on('subscribe:kitchen', () => {
      socket.join('kitchen');
      logger.info('SOCKET', `Room joined: ${socket.id} → kitchen`);
    });

    socket.on('unsubscribe:kitchen', () => {
      socket.leave('kitchen');
      logger.info('SOCKET', `Room left: ${socket.id} ← kitchen`);
    });

    // Admin subscription
    socket.on('subscribe:admin', () => {
      socket.join('admin');
      logger.info('SOCKET', `Room joined: ${socket.id} → admin`);
    });

    socket.on('unsubscribe:admin', () => {
      socket.leave('admin');
      logger.info('SOCKET', `Room left: ${socket.id} ← admin`);
    });

    // Device alert acknowledgement
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

      logger.info('SOCKET', `Device alert acknowledged: ${payload.orderId}`);
    });

    // Error handling
    socket.on('error', (error) => {
      logger.error('SOCKET', `Socket error: ${socket.id}`, { error });
    });

    // Disconnect handling
    socket.on('disconnect', (reason) => {
      logger.info('SOCKET', `Disconnected: ${socket.id}, reason: ${reason}`);
    });
  });
}

setupSocketHandlers();

// ============================================================================
// MIDDLEWARE SETUP
// ============================================================================

// Request ID middleware (must be first)
app.use(requestIdMiddleware);

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false, // Handled by Netlify _headers
  hsts: nodeEnv === 'production' ? {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  } : false,
  noSniff: true,
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// CORS
app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));

// Request timing middleware
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const elapsed = Date.now() - startedAt;
    const healthMonitor = getHealthMonitor();
    healthMonitor.recordAPIRequest(elapsed, res.statusCode >= 400);
  });
  next();
});

// Response compression
app.use(compression());

// Body parsing with size limits
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// Input sanitization
app.use(sanitizeMongo);
app.use(xssSanitize);

// Rate limiting
app.use('/api', apiLimiter);

// HTTPS enforcement in production
if (nodeEnv === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https' && !req.secure) {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// ============================================================================
// HEALTH & READINESS ENDPOINTS (before 404)
// ============================================================================

// Root status endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'NeroCafe API',
    status: 'operational',
    version: '1.0.0',
    environment: nodeEnv,
    timestamp: new Date().toISOString(),
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  const healthMonitor = getHealthMonitor();
  res.json({
    ok: true,
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    metrics: healthMonitor.getHealthStatus(),
  });
});

// Readiness check endpoint
app.get('/ready', (req, res) => {
  const healthMonitor = getHealthMonitor();
  const healthStatus = healthMonitor.getHealthStatus();
  
  // Consider unhealthy if error rate is too high
  const isHealthy = healthStatus.errorRate < 0.05;
  
  res.status(isHealthy ? 200 : 503).json({
    ready: isHealthy,
    status: isHealthy ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
  });
});

// Liveness check endpoint
app.get('/live', (req, res) => {
  res.json({
    alive: true,
    timestamp: new Date().toISOString(),
  });
});

// API health endpoint (legacy)
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

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

// ============================================================================
// STATIC FILES
// ============================================================================

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ============================================================================
// API ROUTES
// ============================================================================

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

// ============================================================================
// RUNTIME ENVIRONMENT VALIDATION MIDDLEWARE
// ============================================================================

app.use((req, res, next) => {
  const requiredEnvVars = ['MONGODB_URI', 'JWT_SECRET', 'ADMIN_JWT_SECRET'];
  const missing = requiredEnvVars.filter(varName => !process.env[varName]);
  
  if (missing.length > 0 && nodeEnv === 'production') {
    logger.error('ENV', `Missing required environment variables: ${missing.join(', ')}`);
    return res.status(500).json({ error: 'Server configuration error' });
  }
  
  next();
});

// ============================================================================
// GLOBAL ERROR HANDLER
// ============================================================================

app.use((err, req, res, next) => {
  logger.error('API', `Internal Server Error: ${err.message}`, { 
    error: err,
    requestId: req.id,
    path: req.path,
    method: req.method,
  });

  // Validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation error',
      details: err.message,
    });
  }

  // Cast errors (invalid MongoDB IDs)
  if (err.name === 'CastError') {
    return res.status(400).json({
      error: 'Invalid ID format',
    });
  }

  // Duplicate key errors
  if (err.code === 11000) {
    return res.status(409).json({
      error: 'Duplicate entry',
      field: Object.keys(err.keyPattern || {})[0],
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: 'Invalid token',
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      error: 'Token expired',
    });
  }

  // Default error response
  const statusCode = err.statusCode || 500;
  const isDevelopment = nodeEnv !== 'production';

  res.status(statusCode).json({
    error: err.message || 'Internal server error',
    ...(isDevelopment && { stack: err.stack }),
  });
});

// ============================================================================
// 404 HANDLER
// ============================================================================

app.use((req, res) => {
  logger.warn('API', `Route not found: ${req.method} ${req.url}`, {
    requestId: req.id,
  });
  res.status(404).json({
    error: 'Route not found',
    path: req.url,
    method: req.method,
  });
});

// ============================================================================
// STARTUP BANNER
// ============================================================================

function printStartupBanner() {
  const banner = `
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║                    NeroCafe API Server                       ║
║                                                               ║
║  Environment: ${nodeEnv.padEnd(44)}║
║  Port: ${String(PORT).padEnd(52)}║
║  Node: ${process.version.padEnd(51)}║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `;
  console.log(banner);
}

printStartupBanner();

// ============================================================================
// GRACEFUL SHUTDOWN HANDLING
// ============================================================================

function setupGracefulShutdown() {
  const shutdown = async (signal) => {
    logger.info('SERVER', `${signal} received, starting graceful shutdown...`);

    // Stop accepting new connections
    httpServer.close(() => {
      logger.info('SERVER', 'HTTP server closed');
    });

    // Close Socket.IO connections
    io.close(() => {
      logger.info('SERVER', 'Socket.IO server closed');
    });

    // Allow time for in-flight requests to complete
    setTimeout(() => {
      logger.info('SERVER', 'Graceful shutdown completed');
      process.exit(0);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.fatal('SERVER', 'Uncaught exception', { error });
    process.exit(1);
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.fatal('SERVER', 'Unhandled promise rejection', { reason, promise });
    process.exit(1);
  });
}

setupGracefulShutdown();

// ============================================================================
// SERVER STARTUP
// ============================================================================

async function startServer() {
  try {
    logger.info('SERVER', 'Connecting to database...');
    await connectDB();

    logger.info('SERVER', 'Running database migrations...');
    await migrateMenuDietaryCategories();

    logger.info('SERVER', 'Initializing ETA Engine...');
    await etaEngine.initialize();
    logger.success('ETA', 'ETA Engine initialized successfully');

    httpServer.listen(PORT, '0.0.0.0', () => {
      logger.success('SERVER', `NeroCafe API listening on port ${PORT}`, {
        environment: nodeEnv,
        clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
        corsOrigins,
      });
    });
  } catch (error) {
    logger.fatal('SERVER', 'Server startup failed', { error });
    process.exit(1);
  }
}

startServer();
