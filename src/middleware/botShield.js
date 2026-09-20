import { logger } from '../utils/logger.js';

// Common malicious bot scanner probe paths
const MALICIOUS_PROBE_PATTERNS = [
  /\/\.env/i,
  /\/\.git/i,
  /\/\.aws/i,
  /\/wp-login\.php/i,
  /\/wp-admin/i,
  /\/xmlrpc\.php/i,
  /\/phpmyadmin/i,
  /\/pma/i,
  /\/adminer/i,
  /\/actuator/i,
  /\/telescope/i,
  /\/solr/i,
  /\/cgi-bin/i,
  /\/etc\/passwd/i,
  /\/shell/i,
  /\/eval-stdin\.php/i,
  /\.php$/i,
  /\.asp$/i,
  /\.aspx$/i,
  /\.jsp$/i,
  /\.sh$/i,
  /\.bak$/i,
  /\.sql$/i,
];

// User agents associated with automated vulnerability scanners
const SUSPICIOUS_SCANNER_UAS = [
  /sqlmap/i,
  /nikto/i,
  /masscan/i,
  /zgrab/i,
  /acunetix/i,
  /dirbuster/i,
  /wpscan/i,
  /nmap/i,
  /gobuster/i,
  /havij/i,
];

/**
 * High-performance bot shield & scanner filter
 * Drops malicious scanners, web probes, and vulnerability scrapers instantly.
 */
export function botShield(req, res, next) {
  const path = req.path || '';
  const ua = req.headers['user-agent'] || '';

  // 1. Check for malicious scanner probe paths
  const isMaliciousPath = MALICIOUS_PROBE_PATTERNS.some((pattern) => pattern.test(path));
  if (isMaliciousPath) {
    logger.warn('SECURITY', `Dropped scanner probe: ${req.method} ${path} from ${req.ip}`);
    return res.status(404).json({ error: 'Not Found' });
  }

  // 2. Check for automated penetration/exploit tool User-Agents
  const isSuspiciousScanner = SUSPICIOUS_SCANNER_UAS.some((pattern) => pattern.test(ua));
  if (isSuspiciousScanner) {
    logger.warn('SECURITY', `Blocked malicious crawler UA: "${ua}" on ${path} from ${req.ip}`);
    return res.status(403).json({ error: 'Access Forbidden' });
  }

  next();
}

/**
 * Sanitizes redirect URLs to prevent Open Redirect vulnerabilities.
 * Ensures the target redirect is always a safe relative path.
 */
export function sanitizeRedirectUrl(url, fallback = '/') {
  if (!url || typeof url !== 'string') return fallback;
  const trimmed = url.trim();
  // Disallow absolute protocol URLs (http:, https:, //, javascript:, data:)
  if (/^(?:[a-z]+:)?\/\//i.test(trimmed) || trimmed.startsWith('//') || /^javascript:/i.test(trimmed)) {
    return fallback;
  }
  // Must start with single slash
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed;
  }
  return fallback;
}
