import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devEnvPath = path.resolve(__dirname, '../.env.dev');
const prodEnvPath = path.resolve(__dirname, '../.env');

if (fs.existsSync(devEnvPath)) {
  dotenv.config({ path: devEnvPath });
} else {
  dotenv.config({ path: prodEnvPath });
}

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
  socket.on('subscribe:order', (orderId) => {
    if (orderId) socket.join(`order:${orderId}`);
  });
  socket.on('unsubscribe:order', (orderId) => {
    if (orderId) socket.leave(`order:${orderId}`);
  });

  socket.on('subscribe:customer', (customerId) => {
    if (customerId) socket.join(`customer:${customerId}`);
  });
  socket.on('unsubscribe:customer', (customerId) => {
    if (customerId) socket.leave(`customer:${customerId}`);
  });
  
  // User-specific rooms for order notifications
  socket.on('subscribe:user', (userId) => {
    if (userId) {
      socket.join(`user:${userId}`);
      console.log(`[Socket] User ${userId} subscribed`);
    }
  });
  socket.on('unsubscribe:user', (userId) => {
    if (userId) {
      socket.leave(`user:${userId}`);
      console.log(`[Socket] User ${userId} unsubscribed`);
    }
  });

  // Kitchen room for live updates
  socket.on('subscribe:kitchen', () => {
    socket.join('kitchen');
    console.log(`[Socket] Kitchen display subscribed`);
  });
  socket.on('unsubscribe:kitchen', () => {
    socket.leave('kitchen');
    console.log(`[Socket] Kitchen display unsubscribed`);
  });

  // Admin room for dashboard updates
  socket.on('subscribe:admin', () => {
    socket.join('admin');
    console.log(`[Socket] Admin dashboard subscribed`);
  });
  socket.on('unsubscribe:admin', () => {
    socket.leave('admin');
    console.log(`[Socket] Admin dashboard unsubscribed`);
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
