import http from 'http';
import { logger } from '../utils/logger.js';

// In-memory cache for IP Geolocation and Proxy/VPN lookups (2 hour TTL)
const ipCache = new Map();
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

function isPrivateOrLocalIp(ip) {
  if (!ip) return true;
  const clean = ip.replace(/^::ffff:/, '').trim();
  if (
    clean === '127.0.0.1' ||
    clean === '::1' ||
    clean === 'localhost' ||
    clean.startsWith('10.') ||
    clean.startsWith('192.168.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(clean)
  ) {
    return true;
  }
  return false;
}

function fetchIpInfo(ip) {
  return new Promise((resolve) => {
    try {
      const clean = ip.replace(/^::ffff:/, '').trim();
      const url = `http://ip-api.com/json/${clean}?fields=status,country,countryCode,proxy,hosting,org`;
      const req = http.get(url, { timeout: 2500 }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            resolve(data.status === 'success' ? data : null);
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Geo-restriction (India Only) & Anti-VPN / Proxy Middleware
 */
export async function geoAndVpnShield(req, res, next) {
  try {
    const rawIp =
      req.headers['cf-connecting-ip'] ||
      req.headers['x-real-ip'] ||
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.ip ||
      '';

    const cleanIp = rawIp.replace(/^::ffff:/, '').trim();

    // 1. Localhost and private LAN are always permitted for local development
    if (isPrivateOrLocalIp(cleanIp)) {
      return next();
    }

    // 2. Check HTTP proxy / Tor headers
    const cfCountry = (req.headers['cf-ipcountry'] || '').toUpperCase();
    const xCountry = (req.headers['x-country-code'] || '').toUpperCase();
    const hasProxyHeader = !!(req.headers['via'] || req.headers['x-proxy-id'] || req.headers['forwarded']);

    // Tor exit nodes are tagged as 'T1' by Cloudflare
    if (cfCountry === 'T1') {
      logger.warn('SECURITY', `Blocked Tor Exit Node access from ${cleanIp}`);
      return res.status(403).json({
        error: 'Access Denied: Tor network detected. Please access NeroCafes through a standard network.',
        code: 'VPN_DETECTED',
      });
    }

    // Direct header country check if proxy provides it
    const proxyCountry = cfCountry || xCountry;
    if (proxyCountry && proxyCountry !== 'IN' && proxyCountry !== 'XX') {
      logger.warn('SECURITY', `Blocked non-India access (Country: ${proxyCountry}) from ${cleanIp}`);
      return res.status(403).json({
        error: `Access Denied: NeroCafes is exclusively available within India. (Detected: ${proxyCountry})`,
        code: 'COUNTRY_RESTRICTED',
        country: proxyCountry,
      });
    }

    // 3. Cached / Live IP lookup for VPN, Hosting, Datacenter, and Country
    let info = ipCache.get(cleanIp);
    const now = Date.now();

    if (!info || info.cachedAt + CACHE_TTL_MS < now) {
      const queried = await fetchIpInfo(cleanIp);
      if (queried) {
        info = { ...queried, cachedAt: now };
        ipCache.set(cleanIp, info);
      }
    }

    if (info) {
      // VPN / Datacenter / Proxy check
      if (info.proxy === true || info.hosting === true || hasProxyHeader) {
        logger.warn('SECURITY', `Blocked VPN/Datacenter proxy (${info.org || 'Unknown'}) from ${cleanIp}`);
        return res.status(403).json({
          error: 'VPN or Proxy detected: Please disconnect your VPN to access NeroCafes.',
          code: 'VPN_DETECTED',
        });
      }

      // Geolocation check (India Only)
      if (info.countryCode && info.countryCode !== 'IN') {
        logger.warn('SECURITY', `Blocked foreign access (${info.country || info.countryCode}) from ${cleanIp}`);
        return res.status(403).json({
          error: `Access Restricted: NeroCafes is exclusively available within India. (Your Location: ${info.country || info.countryCode})`,
          code: 'COUNTRY_RESTRICTED',
          country: info.countryCode,
        });
      }
    }

    next();
  } catch (err) {
    // If geo lookup fails, don't crash request
    logger.error('SECURITY', `Geo & VPN check error: ${err.message}`);
    next();
  }
}

export default geoAndVpnShield;
