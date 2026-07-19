import jwt from 'jsonwebtoken';
import { Admin } from '../models/Admin.js';

export async function authAdmin(req, res, next) {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Admin token required' });

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const admin = await Admin.findById(decoded.sub).select('-password');
    if (!admin) return res.status(401).json({ error: 'Invalid admin' });

    /* Check tokenVersion — if admin logged out of all devices, old tokens are invalid */
    if (decoded.v !== undefined && decoded.v !== (admin.tokenVersion || 0)) {
      return res.status(401).json({ error: 'Session invalidated. Please login again.', code: 'TOKEN_EXPIRED' });
    }

    req.admin = admin;
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}
