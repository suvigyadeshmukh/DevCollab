import crypto from 'crypto';
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest, UserTokenPayload } from '../types';

const JWT_SECRET = process.env.JWT_SECRET || 'devcollab-hmac-sha256-super-secret-key-32-bytes-secure';

function base64UrlEncode(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Zero-dependency password hashing helper using Node native crypto pbkdf2
 */
export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

/**
 * Constant-time password verification helper
 */
export function verifyPassword(password: string, salt: string, storedHash: string): boolean {
  if (!password || !salt || !storedHash) return false;
  try {
    const computedHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    const computedBuffer = Buffer.from(computedHash, 'utf8');
    const storedBuffer = Buffer.from(storedHash, 'utf8');
    if (computedBuffer.length !== storedBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(computedBuffer, storedBuffer);
  } catch {
    return false;
  }
}

/**
 * Sign an auth token using Node native crypto HMAC-SHA256
 */
export function signToken(payload: Record<string, any>, expiresInSec: number = 86400 * 7): string {
  const header = {
    alg: 'HS256',
    typ: 'JWT'
  };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSec
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(dataToSign)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${dataToSign}.${signature}`;
}

/**
 * Verify an auth token using Node native crypto HMAC-SHA256
 */
export function verifyToken<T = UserTokenPayload>(token: string): T | null {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const expectedSignature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(dataToSign)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const sigBuffer = Buffer.from(signature);
  const expectedSigBuffer = Buffer.from(expectedSignature);

  if (sigBuffer.length !== expectedSigBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(sigBuffer, expectedSigBuffer)) {
    return null;
  }

  try {
    const payloadJson = base64UrlDecode(encodedPayload);
    const payload = JSON.parse(payloadJson);

    if (payload.exp && typeof payload.exp === 'number') {
      const now = Math.floor(Date.now() / 1000);
      if (now > payload.exp) {
        return null;
      }
    }

    return payload as T;
  } catch {
    return null;
  }
}

/**
 * Express middleware requiring a valid JWT Bearer token
 */
export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.headers['x-access-token']) {
    token = String(req.headers['x-access-token']).trim();
  }

  if (!token) {
    res.status(401).json({ error: 'Unauthorized: Missing authentication token' });
    return;
  }

  const payload = verifyToken<UserTokenPayload>(token);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized: Invalid or expired authentication token' });
    return;
  }

  req.user = payload;
  next();
}

/**
 * Sliding-window IP/user rate limiter middleware
 */
export function createRateLimiter(maxRequests: number, windowMs: number) {
  const requestHistory = new Map<string, number[]>();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of requestHistory.entries()) {
      const active = timestamps.filter(ts => now - ts < windowMs);
      if (active.length === 0) {
        requestHistory.delete(key);
      } else {
        requestHistory.set(key, active);
      }
    }
  }, 300000);

  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }

  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const key = req.user?.userId ||
      req.ip ||
      (req.headers['x-forwarded-for'] as string) ||
      req.socket.remoteAddress ||
      'unknown-client';

    const now = Date.now();
    const timestamps = requestHistory.get(key) || [];
    const validTimestamps = timestamps.filter(ts => now - ts < windowMs);

    if (validTimestamps.length >= maxRequests) {
      const oldestTimestamp = validTimestamps[0];
      const retryAfterSec = Math.ceil((oldestTimestamp + windowMs - now) / 1000);
      res.setHeader('Retry-After', retryAfterSec);
      res.status(429).json({
        error: 'Too many requests. Please wait before retrying.',
        retryAfter: retryAfterSec
      });
      return;
    }

    validTimestamps.push(now);
    requestHistory.set(key, validTimestamps);
    next();
  };
}

/**
 * Sanitize text to prevent Stored XSS attacks
 */
export function sanitizeText(input: string, maxLength: number = 5000): string {
  if (typeof input !== 'string') return '';

  let sanitized = input;
  if (maxLength > 0 && sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength);
  }

  return sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Validate filename to prevent path traversal, null byte injections, and dotfile tampering
 */
export function validateSafeFilename(name: string): boolean {
  if (!name || typeof name !== 'string') {
    return false;
  }

  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 255) {
    return false;
  }

  // Blocking null bytes and encoded null bytes
  if (trimmed.includes('\0') || trimmed.includes('%00') || /\x00/.test(trimmed)) {
    return false;
  }

  // Blocking path traversal
  if (trimmed.includes('..')) {
    return false;
  }

  // Blocking directory separators
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return false;
  }

  // Blocking dotfiles (.env, .git, .gitignore, etc.)
  if (trimmed.startsWith('.')) {
    return false;
  }

  // Blocking reserved Windows filesystem characters
  const forbiddenChars = /[<>:"|?*]/;
  if (forbiddenChars.test(trimmed)) {
    return false;
  }

  // Blocking Windows reserved device names
  const reservedWindowsNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
  if (reservedWindowsNames.test(trimmed)) {
    return false;
  }

  return true;
}

/**
 * Scans submitted code for RCE and sandbox escape vectors
 */
export function scanCodeForThreats(
  code: string,
  _language?: string
): { safe: boolean; threats: string[]; riskScore: number } {
  if (!code || typeof code !== 'string') {
    return { safe: true, threats: [], riskScore: 0 };
  }

  const threats: string[] = [];
  const normalized = code.toLowerCase();

  // Primary RCE/Escape Vectors required by specification
  const requiredVectors: { pattern: RegExp | string; description: string; score: number }[] = [
    { pattern: 'child_process', description: 'Node.js process spawning module (child_process)', score: 35 },
    { pattern: 'fs.', description: 'Filesystem module access (fs.)', score: 30 },
    { pattern: 'process.env', description: 'Environment variable exfiltration (process.env)', score: 25 },
    { pattern: 'process.mainmodule', description: 'Process mainModule access (process.mainModule)', score: 35 },
    { pattern: 'constructor.constructor', description: 'Function constructor prototype breakout (constructor.constructor)', score: 40 },
    { pattern: '__proto__', description: 'Prototype pollution vector (__proto__)', score: 30 },
    { pattern: 'os.system', description: 'Operating system command execution (os.system)', score: 40 },
    { pattern: 'subprocess', description: 'Subprocess execution module (subprocess)', score: 35 },
    { pattern: '/etc/passwd', description: 'Unix credential file access (/etc/passwd)', score: 40 },
    { pattern: ':(){', description: 'Shell fork bomb pattern (:(){)', score: 50 },
  ];

  // Secondary high-risk injection patterns
  const secondaryVectors: { pattern: RegExp | string; description: string; score: number }[] = [
    { pattern: /require\s*\(\s*['"]child_process['"]\s*\)/i, description: 'Direct require of child_process', score: 40 },
    { pattern: /import\s+.*\s+from\s+['"]child_process['"]/i, description: 'Direct import of child_process', score: 40 },
    { pattern: /\bexec\s*\(/i, description: 'Arbitrary shell execution (exec)', score: 30 },
    { pattern: /\bspawn\s*\(/i, description: 'Arbitrary process spawn (spawn)', score: 30 },
    { pattern: /\brm\s+-rf\b/i, description: 'Destructive deletion command (rm -rf)', score: 50 },
    { pattern: /\b__import__\s*\(\s*['"]os['"]\s*\)/i, description: 'Python dynamic import of os', score: 40 },
    { pattern: /\bshutil\.rmtree\b/i, description: 'Python recursive directory removal (shutil.rmtree)', score: 40 },
    { pattern: /\bnc\s+-e\b/i, description: 'Netcat reverse shell attempt (nc -e)', score: 50 },
    { pattern: /\/bin\/sh|\/bin\/bash/i, description: 'Direct shell binary invocation (/bin/sh, /bin/bash)', score: 30 },
    { pattern: /powershell\.exe/i, description: 'Direct PowerShell binary invocation', score: 30 },
    { pattern: /cmd\.exe/i, description: 'Direct CMD binary invocation', score: 30 },
  ];

  let rawScore = 0;

  for (const item of requiredVectors) {
    if (typeof item.pattern === 'string') {
      if (normalized.includes(item.pattern.toLowerCase())) {
        threats.push(item.description);
        rawScore += item.score;
      }
    } else if (item.pattern.test(code)) {
      threats.push(item.description);
      rawScore += item.score;
    }
  }

  for (const item of secondaryVectors) {
    const matched = typeof item.pattern === 'string'
      ? normalized.includes(item.pattern.toLowerCase())
      : item.pattern.test(code);
    if (matched && !threats.includes(item.description)) {
      threats.push(item.description);
      rawScore += item.score;
    }
  }

  const riskScore = Math.min(100, rawScore);
  const safe = threats.length === 0;

  return {
    safe,
    threats,
    riskScore
  };
}
