import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';

export async function authUser(req, res, next) {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      req.user = null;
      return next();
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.sub).select('-password');
      req.user = user || null;
    } catch (err) {
      /* Distinguish expired tokens from invalid ones so the client can refresh */
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
      }
      req.user = null;
    }
    next();
  } catch {
    req.user = null;
    next();
  }
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  next();
}
