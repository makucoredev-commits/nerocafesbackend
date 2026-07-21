import crypto from 'crypto';

/**
 * Gravatar URL from email (same algorithm as gravatar.com).
 * @see https://docs.gravatar.com/
 */
export function getGravatarUrl(email, { size = 200 } = {}) {
  const normalized = String(email || '')
    .trim()
    .toLowerCase();
  if (!normalized) return '';
  const hash = crypto.createHash('md5').update(normalized).digest('hex');
  const params = new URLSearchParams({
    s: String(size),
    d: 'identicon',
    r: 'pg',
  });
  return `https://www.gravatar.com/avatar/${hash}?${params.toString()}`;
}
