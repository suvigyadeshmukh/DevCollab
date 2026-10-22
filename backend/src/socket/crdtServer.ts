import * as Y from 'yjs';
import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import {
  getFileById,
  getProjectMember,
  getProjectById,
  updateFileContent,
  createComment,
  logSecurityEvent,
  getSecurityLogs
} from '../db';
import { verifyToken, sanitizeText } from '../security/securityMiddleware';
import { UserTokenPayload, CollaboratorRole } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthenticatedSocket extends Socket {
  user: UserTokenPayload;
  currentProjectId?: string;
  currentFileId?: string;
}

interface CursorPosition {
  userId: string;
  username: string;
  avatarUrl?: string;
  lineNumber: number;
  column: number;
  selection?: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  color: string;
  fileId: string;
  timestamp: number;
}

interface Breakpoint {
  id: string;
  fileId: string;
  lineNumber: number;
  userId: string;
  username: string;
  enabled: boolean;
}

interface ChatMessage {
  id: string;
  projectId: string;
  userId: string;
  username: string;
  content: string;
  timestamp: string;
}

// Per-socket token-bucket rate limiter state
interface RateLimitBucket {
  // CRDT/cursor bucket: max 40 events per 1000ms
  crdtTokens: number;
  crdtLastRefill: number;
  // Chat/comment bucket: max 5 events per 10000ms
  chatTimestamps: number[];
}

// ─── In-memory state ──────────────────────────────────────────────────────────

// fileId → Y.Doc
const activeDocs = new Map<string, Y.Doc>();

// projectId → Set<socketId>
const projectRooms = new Map<string, Set<string>>();

// fileId → Set<socketId>
const fileRooms = new Map<string, Set<string>>();

// fileId → Map<userId, CursorPosition>
const activeCursors = new Map<string, Map<string, CursorPosition>>();

// fileId → Map<breakpointId, Breakpoint>
const fileBreakpoints = new Map<string, Map<string, Breakpoint>>();

// projectId → ChatMessage[]  (last 100 messages)
const projectChatHistory = new Map<string, ChatMessage[]>();

// socketId → RateLimitBucket
const rateLimitBuckets = new Map<string, RateLimitBucket>();

// fileId → NodeJS.Timeout (debounce persist timer)
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ─── Constants ────────────────────────────────────────────────────────────────

const CRDT_MAX_TOKENS = 40;        // refill target
const CRDT_REFILL_WINDOW_MS = 1000; // per second
const CHAT_MAX_EVENTS = 5;
const CHAT_WINDOW_MS = 10_000;
const MAX_CRDT_PAYLOAD_BYTES = 32 * 1024; // 32 KB
const PERSIST_DEBOUNCE_MS = 500;
const CURSOR_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9'
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getOrCreateDoc(fileId: string): Y.Doc {
  if (activeDocs.has(fileId)) {
    return activeDocs.get(fileId)!;
  }

  const ydoc = new Y.Doc();
  const file = getFileById(fileId);

  if (file) {
    if (file.yjs_state && Buffer.isBuffer(file.yjs_state) && file.yjs_state.length > 0) {
      // Hydrate from persisted binary Yjs state
      try {
        Y.applyUpdate(ydoc, new Uint8Array(file.yjs_state));
      } catch {
        // Fallback: seed from plain text content
        const ytext = ydoc.getText('monaco');
        ytext.insert(0, file.content || '');
      }
    } else {
      // Seed from plain text content
      const ytext = ydoc.getText('monaco');
      ytext.insert(0, file.content || '');
    }
  }

  activeDocs.set(fileId, ydoc);
  return ydoc;
}

function getCallerRole(projectId: string, userId: string): CollaboratorRole | null {
  const member = getProjectMember(projectId, userId);
  if (member) return member.role;
  const project = getProjectById(projectId);
  if (project && project.owner_id === userId) return 'OWNER';
  return null;
}

function getBucket(socketId: string): RateLimitBucket {
  if (!rateLimitBuckets.has(socketId)) {
    rateLimitBuckets.set(socketId, {
      crdtTokens: CRDT_MAX_TOKENS,
      crdtLastRefill: Date.now(),
      chatTimestamps: []
    });
  }
  return rateLimitBuckets.get(socketId)!;
}

/**
 * Token-bucket check for high-frequency CRDT/cursor events.
 * Refills at CRDT_MAX_TOKENS per CRDT_REFILL_WINDOW_MS.
 * Returns true if the event should be allowed.
 */
function checkCrdtRateLimit(socketId: string): boolean {
  const bucket = getBucket(socketId);
  const now = Date.now();
  const elapsed = now - bucket.crdtLastRefill;

  if (elapsed >= CRDT_REFILL_WINDOW_MS) {
    bucket.crdtTokens = CRDT_MAX_TOKENS;
    bucket.crdtLastRefill = now;
  }

  if (bucket.crdtTokens <= 0) return false;
  bucket.crdtTokens -= 1;
  return true;
}

/**
 * Sliding-window check for low-frequency chat/comment events.
 * Max CHAT_MAX_EVENTS per CHAT_WINDOW_MS.
 */
function checkChatRateLimit(socketId: string): boolean {
  const bucket = getBucket(socketId);
  const now = Date.now();
  bucket.chatTimestamps = bucket.chatTimestamps.filter(ts => now - ts < CHAT_WINDOW_MS);

  if (bucket.chatTimestamps.length >= CHAT_MAX_EVENTS) return false;
  bucket.chatTimestamps.push(now);
  return true;
}

/**
 * Deterministic per-user cursor color based on userId hash.
 */
function getUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

/**
 * Debounce-persist Y.Doc state + plain-text content to SQLite.
 */
function debouncePersistDoc(fileId: string): void {
  if (persistTimers.has(fileId)) {
    clearTimeout(persistTimers.get(fileId)!);
  }

  const timer = setTimeout(() => {
    persistTimers.delete(fileId);
    const ydoc = activeDocs.get(fileId);
    if (!ydoc) return;

    try {
      const stateVector = Y.encodeStateAsUpdate(ydoc);
      const yjsBuf = Buffer.from(stateVector);
      const plainText = ydoc.getText('monaco').toString();
      updateFileContent(fileId, plainText, yjsBuf);
    } catch (err) {
      console.error(`[CRDT] Failed to persist doc for fileId=${fileId}:`, err);
    }
  }, PERSIST_DEBOUNCE_MS);

  persistTimers.set(fileId, timer);
}

/**
 * Broadcast a `WS_FLOOD_THROTTLED` security alert to the violating socket
 * and log to security_logs.
 */
function handleFloodViolation(
  socket: AuthenticatedSocket,
  eventType: string,
  projectId: string | undefined
): void {
  const detail = `WebSocket flood throttled: user "${socket.user.username}" (${socket.user.userId}) exceeded rate limit on event "${eventType}"`;

  logSecurityEvent({
    project_id: projectId || null,
    user_id: socket.user.userId,
    username: socket.user.username,
    event_type: 'WS_FLOOD_THROTTLED',
    severity: 'MEDIUM',
    details: detail,
    blocked: 1
  });

  socket.emit('security-alert', {
    type: 'WS_FLOOD_THROTTLED',
    message: 'Rate limit exceeded. Slow down your event emissions.',
    eventType,
    timestamp: new Date().toISOString()
  });
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export function setupCRDTServer(io: Server): void {

  // ── Socket Authentication Middleware ────────────────────────────────────────
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) {
      return next(new Error('Authentication error: Missing token'));
    }

    const payload = verifyToken<UserTokenPayload>(token);
    if (!payload) {
      return next(new Error('Authentication error: Invalid or expired token'));
    }

    (socket as AuthenticatedSocket).user = payload;
    next();
  });

  // ── Connection Handler ───────────────────────────────────────────────────────
  io.on('connection', (rawSocket) => {
    const socket = rawSocket as AuthenticatedSocket;
    const { userId, username } = socket.user;

    console.log(`[WS] Connected: ${username} (${userId}) — socket ${socket.id}`);

    // Initialize rate-limit bucket for this socket
    getBucket(socket.id);

    // ── join-project ───────────────────────────────────────────────────────────
    socket.on('join-project', (data: { projectId: string }) => {
      if (!data?.projectId) return;
      const { projectId } = data;

      const role = getCallerRole(projectId, userId);
      if (!role) {
        socket.emit('error', { message: 'Access denied: You are not a member of this project' });
        return;
      }

      socket.currentProjectId = projectId;
      socket.join(`project:${projectId}`);

      if (!projectRooms.has(projectId)) projectRooms.set(projectId, new Set());
      projectRooms.get(projectId)!.add(socket.id);

      // Send recent chat history (last 50 messages)
      const history = projectChatHistory.get(projectId) || [];
      const recentHistory = history.slice(-50);
      socket.emit('chat-history', { messages: recentHistory });

      // Notify room of new collaborator
      socket.to(`project:${projectId}`).emit('collaborator-joined', {
        userId,
        username,
        role,
        socketId: socket.id,
        timestamp: new Date().toISOString()
      });

      socket.emit('join-project-ack', {
        projectId,
        role,
        timestamp: new Date().toISOString()
      });
    });

    // ── join-file ──────────────────────────────────────────────────────────────
    socket.on('join-file', (data: { projectId: string; fileId: string }) => {
      if (!data?.fileId || !data?.projectId) return;
      const { projectId, fileId } = data;

      const role = getCallerRole(projectId, userId);
      if (!role) {
        socket.emit('error', { message: 'Access denied: You are not a member of this project' });
        return;
      }

      // Leave previous file room if switching
      if (socket.currentFileId && socket.currentFileId !== fileId) {
        socket.leave(`file:${socket.currentFileId}`);
        const prevRoom = fileRooms.get(socket.currentFileId);
        if (prevRoom) prevRoom.delete(socket.id);

        // Remove cursor from previous file
        const prevCursors = activeCursors.get(socket.currentFileId);
        if (prevCursors) {
          prevCursors.delete(userId);
          socket.to(`file:${socket.currentFileId}`).emit('cursor-removed', { userId });
        }
      }

      socket.currentFileId = fileId;
      socket.join(`file:${fileId}`);

      if (!fileRooms.has(fileId)) fileRooms.set(fileId, new Set());
      fileRooms.get(fileId)!.add(socket.id);

      // Hydrate or create Y.Doc
      const ydoc = getOrCreateDoc(fileId);

      // Encode full state as base64 for transport
      const stateUpdate = Y.encodeStateAsUpdate(ydoc);
      const stateBase64 = Buffer.from(stateUpdate).toString('base64');

      // Collect active cursors for this file
      const cursors = Array.from((activeCursors.get(fileId) || new Map()).values());

      // Collect breakpoints for this file
      const breakpoints = Array.from((fileBreakpoints.get(fileId) || new Map()).values());

      socket.emit('join-file-ack', {
        fileId,
        role,
        yjsStateBase64: stateBase64,
        activeCursors: cursors,
        breakpoints,
        timestamp: new Date().toISOString()
      });
    });

    // ── yjs-update ─────────────────────────────────────────────────────────────
    socket.on('yjs-update', (data: { projectId: string; fileId: string; updateBase64: string }) => {
      if (!checkCrdtRateLimit(socket.id)) {
        handleFloodViolation(socket, 'yjs-update', data?.projectId);
        return;
      }

      if (!data?.fileId || !data?.projectId || !data?.updateBase64) return;
      const { projectId, fileId, updateBase64 } = data;

      // RBAC: verify role from SQLite — block VIEWER writes
      const role = getCallerRole(projectId, userId);
      if (!role) {
        socket.emit('error', { message: 'Access denied: You are not a member of this project' });
        return;
      }

      if (role === 'VIEWER') {
        logSecurityEvent({
          project_id: projectId,
          user_id: userId,
          username,
          event_type: 'UNAUTHORIZED_CRDT_WRITE_BLOCKED',
          severity: 'HIGH',
          details: `VIEWER "${username}" attempted CRDT write on fileId="${fileId}"`,
          blocked: 1
        });
        socket.emit('security-alert', {
          type: 'UNAUTHORIZED_CRDT_WRITE_BLOCKED',
          message: 'VIEWER role cannot make edits. Your change has been blocked.',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Cap payload at 32 KB
      const updateBytes = Buffer.byteLength(updateBase64, 'base64');
      if (updateBytes > MAX_CRDT_PAYLOAD_BYTES) {
        socket.emit('error', {
          message: `CRDT update payload exceeds maximum allowed size (${MAX_CRDT_PAYLOAD_BYTES / 1024}KB)`
        });
        return;
      }

      const ydoc = getOrCreateDoc(fileId);

      try {
        const updateUint8 = new Uint8Array(Buffer.from(updateBase64, 'base64'));
        Y.applyUpdate(ydoc, updateUint8);
      } catch (err) {
        console.error(`[CRDT] Failed to apply update for fileId=${fileId}:`, err);
        socket.emit('error', { message: 'Failed to apply CRDT update: malformed payload' });
        return;
      }

      // Broadcast to all other sockets in the file room
      socket.to(`file:${fileId}`).emit('yjs-update', {
        fileId,
        updateBase64,
        userId,
        username
      });

      // Debounce-persist to SQLite
      debouncePersistDoc(fileId);
    });

    // ── cursor-update ──────────────────────────────────────────────────────────
    socket.on('cursor-update', (data: {
      projectId: string;
      fileId: string;
      lineNumber: number;
      column: number;
      selection?: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      };
    }) => {
      if (!checkCrdtRateLimit(socket.id)) {
        handleFloodViolation(socket, 'cursor-update', data?.projectId);
        return;
      }

      if (!data?.fileId || !data?.projectId) return;
      const { projectId, fileId, lineNumber, column, selection } = data;

      const role = getCallerRole(projectId, userId);
      if (!role) return;

      const cursorData: CursorPosition = {
        userId,
        username,
        lineNumber: typeof lineNumber === 'number' ? lineNumber : 1,
        column: typeof column === 'number' ? column : 1,
        selection,
        color: getUserColor(userId),
        fileId,
        timestamp: Date.now()
      };

      if (!activeCursors.has(fileId)) activeCursors.set(fileId, new Map());
      activeCursors.get(fileId)!.set(userId, cursorData);

      socket.to(`file:${fileId}`).emit('cursor-update', cursorData);
    });

    // ── toggle-breakpoint ──────────────────────────────────────────────────────
    socket.on('toggle-breakpoint', (data: {
      projectId: string;
      fileId: string;
      lineNumber: number;
      breakpointId?: string;
    }) => {
      if (!checkCrdtRateLimit(socket.id)) {
        handleFloodViolation(socket, 'toggle-breakpoint', data?.projectId);
        return;
      }

      if (!data?.fileId || !data?.projectId) return;
      const { projectId, fileId, lineNumber } = data;

      const role = getCallerRole(projectId, userId);
      if (!role || role === 'VIEWER') return;

      if (!fileBreakpoints.has(fileId)) fileBreakpoints.set(fileId, new Map());
      const bpMap = fileBreakpoints.get(fileId)!;

      // Find existing breakpoint on this line by this user (or any user — shared)
      let found: Breakpoint | undefined;
      for (const bp of bpMap.values()) {
        if (bp.lineNumber === lineNumber) {
          found = bp;
          break;
        }
      }

      let action: 'added' | 'removed' | 'toggled';
      let affectedBreakpoint: Breakpoint;

      if (found) {
        // Toggle enabled state
        found.enabled = !found.enabled;
        affectedBreakpoint = found;
        action = 'toggled';
      } else {
        // Add new breakpoint
        const newBp: Breakpoint = {
          id: data.breakpointId || uuidv4(),
          fileId,
          lineNumber,
          userId,
          username,
          enabled: true
        };
        bpMap.set(newBp.id, newBp);
        affectedBreakpoint = newBp;
        action = 'added';
      }

      // Broadcast to entire file room including sender
      io.to(`file:${fileId}`).emit('breakpoint-update', {
        action,
        breakpoint: affectedBreakpoint,
        userId,
        username
      });
    });

    // ── chat-message ───────────────────────────────────────────────────────────
    socket.on('chat-message', (data: { projectId: string; content: string }) => {
      if (!checkChatRateLimit(socket.id)) {
        handleFloodViolation(socket, 'chat-message', data?.projectId);
        return;
      }

      if (!data?.projectId || !data?.content) return;
      const { projectId } = data;

      const role = getCallerRole(projectId, userId);
      if (!role) {
        socket.emit('error', { message: 'Access denied: You are not a member of this project' });
        return;
      }

      const sanitizedContent = sanitizeText(
        typeof data.content === 'string' ? data.content.trim() : '',
        500
      );
      if (!sanitizedContent) return;

      const message: ChatMessage = {
        id: uuidv4(),
        projectId,
        userId,
        username,
        content: sanitizedContent,
        timestamp: new Date().toISOString()
      };

      // Persist to in-memory history (rolling window of 100 messages)
      if (!projectChatHistory.has(projectId)) projectChatHistory.set(projectId, []);
      const history = projectChatHistory.get(projectId)!;
      history.push(message);
      if (history.length > 100) history.shift();

      // Broadcast to entire project room
      io.to(`project:${projectId}`).emit('chat-message', message);
    });

    // ── new-comment ────────────────────────────────────────────────────────────
    socket.on('new-comment', (data: {
      projectId: string;
      fileId: string;
      lineNumber: number;
      content: string;
    }) => {
      if (!checkChatRateLimit(socket.id)) {
        handleFloodViolation(socket, 'new-comment', data?.projectId);
        return;
      }

      if (!data?.projectId || !data?.fileId || !data?.content) return;
      const { projectId, fileId, lineNumber, content } = data;

      const role = getCallerRole(projectId, userId);
      if (!role) {
        socket.emit('error', { message: 'Access denied: You are not a member of this project' });
        return;
      }

      const file = getFileById(fileId);
      if (!file || file.project_id !== projectId) {
        socket.emit('error', { message: 'File not found in this project' });
        return;
      }

      const parsedLine = typeof lineNumber === 'number' ? lineNumber : parseInt(String(lineNumber), 10);
      if (isNaN(parsedLine) || parsedLine < 1) {
        socket.emit('error', { message: 'Invalid line number' });
        return;
      }

      const sanitizedContent = sanitizeText(
        typeof content === 'string' ? content.trim() : '',
        2000
      );
      if (!sanitizedContent) return;

      const comment = createComment(
        uuidv4(),
        projectId,
        fileId,
        parsedLine,
        userId,
        username,
        sanitizedContent
      );

      // Broadcast to entire project room
      io.to(`project:${projectId}`).emit('new-comment', { comment });
    });

    // ── snapshot-restored ──────────────────────────────────────────────────────
    socket.on('snapshot-restored', (data: { projectId: string; snapshotId: string; snapshotName: string }) => {
      if (!data?.projectId) return;
      const { projectId } = data;

      const role = getCallerRole(projectId, userId);
      if (!role || role === 'VIEWER') return;

      // Update server Y.Docs for all files in the project from the restored database state
      for (const [fileId, _doc] of activeDocs.entries()) {
        const file = getFileById(fileId);
        if (file?.project_id === projectId) {
          if (persistTimers.has(fileId)) {
            clearTimeout(persistTimers.get(fileId)!);
            persistTimers.delete(fileId);
          }

          // Re-create Y.Doc with restored file content
          const newDoc = new Y.Doc();
          const newText = newDoc.getText('monaco');
          newText.insert(0, file.content || '');
          activeDocs.set(fileId, newDoc);

          // Persist the binary state vector to SQLite
          const stateVector = Y.encodeStateAsUpdate(newDoc);
          updateFileContent(fileId, file.content || '', Buffer.from(stateVector));

          // Broadcast fresh state to all sockets in the file room so open editors reflect it
          const stateBase64 = Buffer.from(stateVector).toString('base64');
          io.to(`file:${fileId}`).emit('yjs-update', {
            fileId,
            updateBase64: stateBase64,
            userId: 'system',
            username: 'System'
          });
        }
      }

      // Notify all project sockets that snapshot has been restored
      io.to(`project:${projectId}`).emit('snapshot-restored', {
        projectId,
        snapshotId: data.snapshotId,
        snapshotName: sanitizeText(data.snapshotName || 'Snapshot', 100),
        restoredBy: username,
        timestamp: new Date().toISOString()
      });
    });

    // ── disconnect ─────────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[WS] Disconnected: ${username} (${userId}) — reason: ${reason}`);

      // Clean up project room
      if (socket.currentProjectId) {
        const projectRoom = projectRooms.get(socket.currentProjectId);
        if (projectRoom) {
          projectRoom.delete(socket.id);
          if (projectRoom.size === 0) projectRooms.delete(socket.currentProjectId);
        }

        socket.to(`project:${socket.currentProjectId}`).emit('collaborator-left', {
          userId,
          username,
          socketId: socket.id,
          timestamp: new Date().toISOString()
        });
      }

      // Clean up file room and cursor
      if (socket.currentFileId) {
        const fileRoom = fileRooms.get(socket.currentFileId);
        if (fileRoom) {
          fileRoom.delete(socket.id);
          if (fileRoom.size === 0) {
            fileRooms.delete(socket.currentFileId);
            // Evict Y.Doc from memory when no sockets remain in the file room
            // (already persisted via debounce, or will be on next update)
            activeDocs.delete(socket.currentFileId);
          }
        }

        const cursors = activeCursors.get(socket.currentFileId);
        if (cursors) {
          cursors.delete(userId);
          if (cursors.size === 0) activeCursors.delete(socket.currentFileId);
          socket.to(`file:${socket.currentFileId}`).emit('cursor-removed', { userId });
        }
      }

      // Clean up rate limit bucket
      rateLimitBuckets.delete(socket.id);
    });
  });

  console.log('[CRDT] WebSocket server initialized with auth, rate-limiting, and CRDT sync');
}
