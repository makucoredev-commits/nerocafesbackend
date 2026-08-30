import mongoSanitize from 'express-mongo-sanitize';

/**
 * Mongo-sanitize middleware – strips dollar-sign and dot operators from
 * req.body / req.query / req.params to prevent NoSQL injection.
 */
export const sanitizeMongo = mongoSanitize({
  replaceWith: '_',
  allowDots: false,
});

/**
 * Basic XSS scrubber – encodes HTML entities in all string values of an object.
 * Applied as express middleware on req.body.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function deepSanitize(obj) {
  if (typeof obj === 'string') return escapeHtml(obj);
  if (Array.isArray(obj)) return obj.map(deepSanitize);
  if (obj && typeof obj === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      clean[k] = deepSanitize(v);
    }
    return clean;
  }
  return obj;
}

export function xssSanitize(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = deepSanitize(req.body);
  }
  next();
}
