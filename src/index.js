import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Environment loading logic:
// - Development (NODE_ENV !== "production"): Load .env.dev
// - Production: Use Render Environment Variables, do NOT load local files
const nodeEnv = process.env.NODE_ENV || 'development';

if (nodeEnv !== 'production') {
  const devEnvPath = path.resolve(__dirname, '../.env.dev');
  if (fs.existsSync(devEnvPath)) {
    dotenv.config({ path: devEnvPath });
    console.log('[Config] Loaded .env.dev for development');
  } else {
    console.warn('[Config] .env.dev not found, using system environment variables');
  }
} else {
  // Production: Use Render Environment Variables only
  console.log('[Config] Production mode: Using Render Environment Variables');
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
    console.error('\n========================================');
    console.error('FATAL: Missing required environment variables');
    console.error('========================================');
    console.error('Missing variables:');
    missing.forEach(v => console.error(`  - ${v}`));
    console.error('\nPlease set these variables and restart the server.');
    console.error('========================================\n');
    process.exit(1);
  }

  // Razorpay key validation
  const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
  if (razorpayKeyId) {
    const isTestKey = razorpayKeyId.startsWith('rzp_test_');
    const isLiveKey = razorpayKeyId.startsWith('rzp_live_');

    if (isProduction && isTestKey) {
      console.warn('\n[WARNING] Production environment is using Razorpay TEST keys.');
      console.warn('[WARNING] Please update to live keys for production payments.\n');
    } else if (!isProduction && isLiveKey) {
      console.warn('\n[WARNING] Development environment is using Razorpay LIVE keys.');
      console.warn('[WARNING] Consider using test keys for development.\n');
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

  // Print environment info (without secrets)
  console.log('\n========================================');
  console.log('Environment Configuration');
  console.log('========================================');
  console.log(`Environment: ${nodeEnv.toUpperCase()}`);
  console.log(`Database Name: ${dbName}`);
  console.log(`Client Origin: ${process.env.CLIENT_ORIGIN}`);
  console.log(`API Port: ${process.env.PORT || 5000}`);
  console.log(`Socket.IO: Enabled`);
  console.log(`Razorpay Mode: ${razorpayKeyId?.startsWith('rzp_test_') ? 'TEST' : 'LIVE'}`);
  console.log('========================================\n');
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
  console.log(`[Socket] Client connected: ${socket.id}`);

  socket.on('subscribe:order', (orderId) => {
    if (orderId) {
      socket.join(`order:${orderId}`);
      console.log(`[Socket] Socket ${socket.id} joined order room: ${orderId}`);
    }
  });
  socket.on('unsubscribe:order', (orderId) => {
    if (orderId) {
      socket.leave(`order:${orderId}`);
      console.log(`[Socket] Socket ${socket.id} left order room: ${orderId}`);
    }
  });

  socket.on('subscribe:customer', (customerId) => {
    if (customerId) {
      socket.join(`customer:${customerId}`);
      console.log(`[Socket] Socket ${socket.id} joined customer room: ${customerId}`);
    }
  });
  socket.on('unsubscribe:customer', (customerId) => {
    if (customerId) {
      socket.leave(`customer:${customerId}`);
      console.log(`[Socket] Socket ${socket.id} left customer room: ${customerId}`);
    }
  });

  // User-specific rooms for order notifications
  socket.on('subscribe:user', (userId) => {
    if (userId) {
      socket.join(`user:${userId}`);
      console.log(`[Socket] Socket ${socket.id} joined user room: ${userId}`);
    }
  });
  socket.on('unsubscribe:user', (userId) => {
    if (userId) {
      socket.leave(`user:${userId}`);
      console.log(`[Socket] Socket ${socket.id} left user room: ${userId}`);
    }
  });

  // Kitchen room for live updates
  socket.on('subscribe:kitchen', () => {
    socket.join('kitchen');
    console.log(`[Socket] Socket ${socket.id} joined kitchen room`);
  });
  socket.on('unsubscribe:kitchen', () => {
    socket.leave('kitchen');
    console.log(`[Socket] Socket ${socket.id} left kitchen room`);
  });

  // Admin room for dashboard updates
  socket.on('subscribe:admin', () => {
    socket.join('admin');
    console.log(`[Socket] Socket ${socket.id} joined admin room`);
  });
  socket.on('unsubscribe:admin', () => {
    socket.leave('admin');
    console.log(`[Socket] Socket ${socket.id} left admin room`);
  });

  // Cleanup on disconnect
  socket.on('disconnect', (reason) => {
    console.log(`[Socket] Client disconnected: ${socket.id}, reason: ${reason}`);
  });

  socket.on('error', (error) => {
    console.error(`[Socket] Socket error for ${socket.id}:`, error);
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
      console.error('[Socket] Failed to update customer alert audit:', error.message);
    }

    console.log('[Socket] Device alert acknowledgement relayed to admin:', payload.orderId);
  });
});

/* ── Request logging middleware ──────────────────────────────────── */
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    const start = Date.now();
    
    res.on('finish', () => {
      const duration = Date.now() - start;
      const logData = {
        method: req.method,
        url: req.url,
        status: res.statusCode,
        duration: `${duration}ms`,
        ip: req.ip,
        userAgent: req.get('user-agent')?.substring(0, 100),
      };

      // Color-coded logging based on status code
      if (res.statusCode >= 500) {
        console.error('[Request] ERROR', logData);
      } else if (res.statusCode >= 400) {
        console.warn('[Request] WARN', logData);
      } else if (duration > 1000) {
        console.warn('[Request] SLOW', logData);
      } else {
        console.log('[Request] INFO', logData);
      }
    });

    next();
  });
}

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
    console.error('[Security] Missing required environment variables:', missing);
    return res.status(500).json({ error: 'Server configuration error' });
  }
  
  next();
});

/* ── Global error handler ───────────────────────────────────────── */
app.use((err, req, res, next) => {
  console.error('[Global Error Handler]', {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
  });

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
  console.warn('[404] Route not found:', req.method, req.url);
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

connectDB()
  .then(async () => {
    await migrateMenuDietaryCategories();
    // Initialize ETA Engine with existing orders
    await etaEngine.initialize();
    
    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`NeroCafe API on port ${PORT}`);
      console.log(`Connected to Site: ${process.env.CLIENT_ORIGIN || 'http://localhost:5173'}`);
      console.log(`Local Network Access: http://<YOUR-IP>:${PORT}`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
