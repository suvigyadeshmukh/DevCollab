import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  createUser,
  getUserByEmail,
  getUserById,
  getUserByIdentifier,
  getUserByUsername,
  logSecurityEvent
} from '../db';
import {
  hashPassword,
  requireAuth,
  sanitizeText,
  signToken,
  verifyPassword
} from '../security/securityMiddleware';
import { AuthenticatedRequest } from '../types';

export const authRouter = Router();

const AVATAR_COLORS = [
  '#00F0FF', // Cyan
  '#7000FF', // Purple
  '#FF007A', // Neon Pink
  '#00FF9D', // Emerald
  '#FFB800', // Amber
  '#A855F7', // Violet
  '#3B82F6'  // Blue
];

/**
 * POST /register
 * Production-grade registration with email, username, and pbkdf2 hashed password
 */
authRouter.post('/register', (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { username, email, password } = req.body;

    // 1. Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || typeof email !== 'string' || !emailRegex.test(email.trim())) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }

    // 2. Username validation
    if (!username || typeof username !== 'string' || username.trim().length < 2) {
      res.status(400).json({ error: 'Username must be at least 2 characters.' });
      return;
    }

    // 3. Password minimum 6-character validation
    if (!password || typeof password !== 'string' || password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters long.' });
      return;
    }

    const sanitizedUsername = sanitizeText(username.trim(), 40);
    const sanitizedEmail = email.trim().toLowerCase();

    // 4. Duplicate checks
    if (getUserByEmail(sanitizedEmail)) {
      res.status(409).json({ error: 'An account with this email address already exists.' });
      return;
    }

    if (getUserByUsername(sanitizedUsername)) {
      res.status(409).json({ error: 'Username is already taken. Please choose another.' });
      return;
    }

    // 5. Zero-dependency PBKDF2 hash
    const { salt, hash } = hashPassword(password);
    const userId = uuidv4();
    const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    const avatarUrl = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(sanitizedUsername)}`;

    const newUser = createUser(
      userId,
      sanitizedUsername,
      sanitizedEmail,
      hash,
      salt,
      avatarColor,
      avatarUrl
    );

    // 6. Sign HMAC-SHA256 JWT
    const token = signToken({
      userId: newUser.id,
      username: newUser.username,
      email: newUser.email
    });

    res.status(201).json({
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        avatar_color: newUser.avatar_color
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Registration failed', details: error.message });
  }
});

/**
 * POST /login
 * Production-grade login with constant-time password verification & SIEM failure logging
 */
authRouter.post('/login', (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { emailOrUsername, password } = req.body;

    if (!emailOrUsername || typeof emailOrUsername !== 'string' || !password || typeof password !== 'string') {
      res.status(400).json({ error: 'Email/username and password are required.' });
      return;
    }

    const identifier = emailOrUsername.trim();
    const user = getUserByIdentifier(identifier);

    // Verify hash or reject
    if (!user || !user.password_hash || !user.salt || !verifyPassword(password, user.salt, user.password_hash)) {
      logSecurityEvent({
        event_type: 'AUTH_FAILURE',
        severity: 'HIGH',
        details: `Failed authentication attempt for identifier: "${identifier}"`,
        blocked: 1,
        username: identifier
      });

      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = signToken({
      userId: user.id,
      username: user.username,
      email: user.email
    });

    res.status(200).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar_color: user.avatar_color || '#00F0FF'
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Authentication failed', details: error.message });
  }
});

/**
 * GET /me
 * Protected profile retrieval for authenticated session validation
 */
authRouter.get('/me', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const userId = req.user!.userId;
    const user = getUserById(userId);

    if (!user) {
      res.status(404).json({ error: 'User account not found' });
      return;
    }

    res.status(200).json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar_color: user.avatar_color || '#00F0FF'
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to retrieve profile', details: error.message });
  }
});
