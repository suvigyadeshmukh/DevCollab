import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';

import { authRouter } from './routes/auth';
import { projectsRouter } from './routes/projects';
import { filesRouter } from './routes/files';
import { createExecuteRouter } from './routes/execute';
import { setupCRDTServer } from './socket/crdtServer';

// ─── Configuration ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '4000', 10);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

// ─── Express App ───────────────────────────────────────────────────────────────

const app = express();

// ── Security Headers Middleware ─────────────────────────────────────────────────
app.use((_req, res, next) => {
  // Prevent MIME-type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent clickjacking via iframes
  res.setHeader('X-Frame-Options', 'DENY');

  // Strict Content Security Policy
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",         // Allow inline styles (Monaco editor)
      "img-src 'self' data: https://api.dicebear.com",
      "font-src 'self' data:",
      "connect-src 'self' ws://localhost:4000 wss://localhost:4000",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  );

  // Prevent information leakage via referrer
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Disable browser features not needed by the app
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Remove Express fingerprint header
  res.removeHeader('X-Powered-By');

  next();
});

// ── CORS ────────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests from the configured client origin and same-origin (no origin header)
      if (!origin || origin === CLIENT_ORIGIN) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: Origin "${origin}" not permitted`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Access-Token'],
    credentials: true,
    maxAge: 86400 // Cache preflight for 24h
  })
);

// ── Body Parsers ────────────────────────────────────────────────────────────────
// Hard cap at 100 KB to prevent body-payload abuse
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// ─── HTTP Server & Socket.IO ───────────────────────────────────────────────────

const httpServer = createServer(app);

const io = new Server(httpServer, {
  // Hard cap on raw WS frame size: 64 KB
  maxHttpBufferSize: 65536,
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true
  },
  // Prefer WebSocket, fall back to polling
  transports: ['websocket', 'polling'],
  // Ping timeout / interval tuning
  pingTimeout: 20000,
  pingInterval: 25000
});

// ─── CRDT WebSocket Server ─────────────────────────────────────────────────────
setupCRDTServer(io);

// ─── REST API Routes ───────────────────────────────────────────────────────────

// Health check (no auth required)
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'DevCollab Backend',
    timestamp: new Date().toISOString(),
    port: PORT
  });
});

// Mount routers
app.use('/api/auth', authRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/files', filesRouter);
app.use('/api/execute', createExecuteRouter(io));

// ── 404 Catch-All ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Resource not found' });
});

// ── Global Error Handler ────────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[DevCollab] Unhandled error:', err.message);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║        DevCollab Backend  —  Port ${PORT}           ║`);
  console.log(`╠══════════════════════════════════════════════════╣`);
  console.log(`║  REST API :  http://localhost:${PORT}/api          ║`);
  console.log(`║  WebSocket:  ws://localhost:${PORT}                ║`);
  console.log(`║  Health   :  http://localhost:${PORT}/health       ║`);
  console.log(`║  CORS for :  ${CLIENT_ORIGIN.padEnd(35)} ║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);
});

export { app, io, httpServer };
