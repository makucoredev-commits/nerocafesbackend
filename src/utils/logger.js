import { AsyncLocalStorage } from 'async_hooks';

// AsyncLocalStorage storage for request correlation context
export const logStorage = new AsyncLocalStorage();

// Constants
export const LOG_LEVELS = {
  TRACE: { val: 0, color: '\x1b[90m' }, // Dim Gray
  DEBUG: { val: 1, color: '\x1b[34m' }, // Blue
  INFO: { val: 2, color: '\x1b[36m' },  // Cyan
  SUCCESS: { val: 3, color: '\x1b[32m' }, // Green
  WARN: { val: 4, color: '\x1b[33m' },  // Yellow
  ERROR: { val: 5, color: '\x1b[31m' }, // Red
  FATAL: { val: 6, color: '\x1b[41m\x1b[37m' } // Red Bg, White Text
};

// ANSI Color reset
const RESET_COLOR = '\x1b[0m';

// Sanitization lists
const SENSITIVE_KEYS = [
  'password', 'pass', 'jwt', 'token', 'otp', 'secret',
  'uri', 'key', 'apikey', 'auth', 'authorization', 'smtp_pass', 'mongodb_uri'
];

/**
 * Scrub sensitive details from metadata to prevent leaking secrets/credentials
 */
function sanitizeMetadata(data) {
  if (!data) return data;
  if (typeof data !== 'object') return data;

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map(item => sanitizeMetadata(item));
  }

  const result = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.some(k => lowerKey.includes(k))) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeMetadata(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Inspect call stack to extract the caller file and function name
 */
function getCallerInfo(error) {
  const stack = error?.stack || new Error().stack;
  if (!stack) return { file: 'unknown', function: 'unknown' };

  const lines = stack.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Skip frames internal to the logging system, async_hooks, or standard node libraries
    if (
      line.includes('logger.js') || 
      line.includes('async_hooks') || 
      line.includes('node:internal') ||
      line.includes('mongoose')
    ) {
      continue;
    }
    
    // Pattern match standard Node stack trace frames: "at func (filepath:line:col)" or "at filepath:line:col"
    const match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/) || line.match(/at\s+(.+?):(\d+):(\d+)/);
    if (match) {
      if (match[2]) {
        const funcName = match[1];
        const filepath = match[2];
        const filename = filepath.split(/[/\\]/).pop();
        return { file: filename, function: funcName };
      } else {
        const filepath = match[1];
        const filename = filepath.split(/[/\\]/).pop();
        return { file: filename, function: 'anonymous' };
      }
    }
  }
  return { file: 'unknown', function: 'unknown' };
}

/**
 * Main Logger implementation
 */
class Logger {
  log(level, module, message, meta = {}) {
    const timestamp = new Date().toISOString();
    
    // Access the AsyncLocalStorage context if available
    const store = logStorage.getStore() || {};
    const requestId = store.requestId || 'system';

    // Retrieve caller diagnostic frame
    const caller = getCallerInfo(meta?.err || meta?.error);

    // Sanitize meta parameters to avoid logging PII
    const cleanMeta = sanitizeMetadata(meta);

    // If an error is passed, enrich metadata with detailed fields required
    if (meta?.err || meta?.error) {
      const err = meta.err || meta.error;
      cleanMeta.error = {
        message: err.message,
        stack: err.stack,
        file: cleanMeta.error?.file || caller.file,
        function: cleanMeta.error?.function || caller.function,
      };
    }

    const isProduction = process.env.NODE_ENV === 'production';
    const envTag = isProduction ? 'PROD' : 'DEV';
    const forceJson = process.env.LOG_FORMAT === 'json';
    
    // Always use pretty string format unless JSON is explicitly forced
    const useJsonFormat = forceJson;

    if (useJsonFormat) {
      // Production format: Strict structured JSON
      const jsonLog = {
        timestamp,
        requestId,
        module,
        level,
        message,
        caller,
        executionTime: store.startTime ? `${Date.now() - store.startTime}ms` : undefined,
        http: store.method ? { method: store.method, url: store.url, userId: store.userId } : undefined,
        ...cleanMeta
      };
      
      if (level === 'ERROR' || level === 'FATAL') {
        console.error(JSON.stringify(jsonLog));
      } else if (level === 'WARN') {
        console.warn(JSON.stringify(jsonLog));
      } else {
        console.log(JSON.stringify(jsonLog));
      }
    } else {
      // Development/TTY format: [Timestamp] [PROD/DEV] [RequestID] [Module] [Level] Message
      const levelColor = LOG_LEVELS[level]?.color || '';
      const reqIdPart = requestId === 'system' ? 'system' : requestId;
      
      let formattedLog = `[${timestamp}] [${envTag}] [${reqIdPart}] [${module}] ${levelColor}${level}${RESET_COLOR} ${message}`;
      
      // Append extra context like HTTP info if present
      if (store.method) {
        const time = store.startTime ? `${Date.now() - store.startTime}ms` : '';
        formattedLog += ` - ${store.method} ${store.url} ${time}`;
      }
      
      if (level === 'ERROR' || level === 'FATAL') {
        console.error(formattedLog);
        if (cleanMeta.error?.stack) {
          console.error(`\x1b[90m${cleanMeta.error.stack}\x1b[0m`);
        }
      } else if (level === 'WARN') {
        console.warn(formattedLog);
      } else {
        console.log(formattedLog);
      }
    }
  }

  trace(module, message, meta) {
    this.log('TRACE', module, message, meta);
  }

  debug(module, message, meta) {
    this.log('DEBUG', module, message, meta);
  }

  info(module, message, meta) {
    this.log('INFO', module, message, meta);
  }

  success(module, message, meta) {
    this.log('SUCCESS', module, message, meta);
  }

  warn(module, message, meta) {
    this.log('WARN', module, message, meta);
  }

  error(module, message, meta) {
    this.log('ERROR', module, message, meta);
  }

  fatal(module, message, meta) {
    this.log('FATAL', module, message, meta);
  }
}

export const logger = new Logger();
