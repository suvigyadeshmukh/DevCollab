import Database from 'better-sqlite3';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { hashPassword } from './security/securityMiddleware';
import {
  CollaboratorRole,
  InlineComment,
  Project,
  ProjectFile,
  ProjectMember,
  SecurityEvent,
  User,
  VersionSnapshot
} from './types';

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), 'devcollab.sqlite');
export const db = new Database(dbPath);

// Enable WAL mode and foreign key constraints
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 1. Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT,
    salt TEXT,
    avatar_color TEXT,
    avatar_url TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    owner_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS project_members (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    UNIQUE(project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    language TEXT NOT NULL,
    content TEXT NOT NULL,
    yjs_state BLOB,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, name),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    files_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    content TEXT NOT NULL,
    is_resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS security_logs (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    user_id TEXT,
    username TEXT,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    details TEXT NOT NULL,
    blocked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

// Safe column migrations for existing databases
try {
  const tableInfo = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
  const colNames = tableInfo.map(c => c.name);
  if (!colNames.includes('email')) {
    db.prepare(`ALTER TABLE users ADD COLUMN email TEXT`).run();
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`).run();
  }
  if (!colNames.includes('password_hash')) {
    db.prepare(`ALTER TABLE users ADD COLUMN password_hash TEXT`).run();
  }
  if (!colNames.includes('salt')) {
    db.prepare(`ALTER TABLE users ADD COLUMN salt TEXT`).run();
  }
  if (!colNames.includes('avatar_color')) {
    db.prepare(`ALTER TABLE users ADD COLUMN avatar_color TEXT`).run();
  }
} catch {
  // column check fallback
}

// 2. 100% Prepared Statements
const stmts = {
  // Users
  insertUser: db.prepare(`
    INSERT INTO users (id, username, email, password_hash, salt, avatar_color, avatar_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getUserById: db.prepare(`
    SELECT id, username, email, password_hash, salt, avatar_color, avatar_url, created_at
    FROM users
    WHERE id = ?
  `),
  getUserByUsername: db.prepare(`
    SELECT id, username, email, password_hash, salt, avatar_color, avatar_url, created_at
    FROM users
    WHERE username = ?
  `),
  getUserByEmail: db.prepare(`
    SELECT id, username, email, password_hash, salt, avatar_color, avatar_url, created_at
    FROM users
    WHERE LOWER(email) = LOWER(?)
  `),
  getUserByIdentifier: db.prepare(`
    SELECT id, username, email, password_hash, salt, avatar_color, avatar_url, created_at
    FROM users
    WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)
  `),

  // Projects
  insertProject: db.prepare(`
    INSERT INTO projects (id, name, description, invite_code, owner_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getProjectById: db.prepare(`
    SELECT id, name, description, invite_code, owner_id, created_at
    FROM projects
    WHERE id = ?
  `),
  getProjectByInviteCode: db.prepare(`
    SELECT id, name, description, invite_code, owner_id, created_at
    FROM projects
    WHERE invite_code = ?
  `),
  getUserProjects: db.prepare(`
    SELECT p.*, pm.role
    FROM projects p
    JOIN project_members pm ON p.id = pm.project_id
    WHERE pm.user_id = ?
    ORDER BY p.created_at DESC
  `),
  deleteProject: db.prepare(`
    DELETE FROM projects
    WHERE id = ?
  `),

  // Project Members
  insertMember: db.prepare(`
    INSERT INTO project_members (id, project_id, user_id, role, joined_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  getMember: db.prepare(`
    SELECT pm.id, pm.project_id, pm.user_id, pm.role, pm.joined_at, u.username
    FROM project_members pm
    JOIN users u ON pm.user_id = u.id
    WHERE pm.project_id = ? AND pm.user_id = ?
  `),
  getMembersByProject: db.prepare(`
    SELECT pm.id, pm.project_id, pm.user_id, pm.role, pm.joined_at, u.username
    FROM project_members pm
    JOIN users u ON pm.user_id = u.id
    WHERE pm.project_id = ?
    ORDER BY pm.joined_at ASC
  `),
  updateMemberRole: db.prepare(`
    UPDATE project_members
    SET role = ?
    WHERE project_id = ? AND user_id = ?
  `),
  removeMember: db.prepare(`
    DELETE FROM project_members
    WHERE project_id = ? AND user_id = ?
  `),

  // Files
  insertFile: db.prepare(`
    INSERT INTO files (id, project_id, name, language, content, yjs_state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getFilesByProject: db.prepare(`
    SELECT id, project_id, name, language, content, yjs_state, created_at, updated_at
    FROM files
    WHERE project_id = ?
    ORDER BY name ASC
  `),
  getFileById: db.prepare(`
    SELECT id, project_id, name, language, content, yjs_state, created_at, updated_at
    FROM files
    WHERE id = ?
  `),
  getFileByName: db.prepare(`
    SELECT id, project_id, name, language, content, yjs_state, created_at, updated_at
    FROM files
    WHERE project_id = ? AND name = ?
  `),
  updateFileContent: db.prepare(`
    UPDATE files
    SET content = ?, yjs_state = ?, updated_at = ?
    WHERE id = ?
  `),
  updateFileDetails: db.prepare(`
    UPDATE files
    SET name = ?, language = ?, content = ?, yjs_state = ?, updated_at = ?
    WHERE id = ?
  `),
  deleteFile: db.prepare(`
    DELETE FROM files
    WHERE id = ?
  `),

  // Snapshots
  insertSnapshot: db.prepare(`
    INSERT INTO snapshots (id, project_id, name, created_by, files_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getSnapshotsByProject: db.prepare(`
    SELECT s.id, s.project_id, s.name, s.created_by, s.files_json, s.created_at, u.username as creator_name
    FROM snapshots s
    LEFT JOIN users u ON s.created_by = u.id
    WHERE s.project_id = ?
    ORDER BY s.created_at DESC
  `),
  getSnapshotById: db.prepare(`
    SELECT s.id, s.project_id, s.name, s.created_by, s.files_json, s.created_at, u.username as creator_name
    FROM snapshots s
    LEFT JOIN users u ON s.created_by = u.id
    WHERE s.id = ?
  `),

  // Comments
  insertComment: db.prepare(`
    INSERT INTO comments (id, project_id, file_id, line_number, author_id, author_name, content, is_resolved, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getCommentsByProject: db.prepare(`
    SELECT id, project_id, file_id, line_number, author_id, author_name, content, is_resolved, created_at
    FROM comments
    WHERE project_id = ?
    ORDER BY created_at ASC
  `),
  getCommentsByFile: db.prepare(`
    SELECT id, project_id, file_id, line_number, author_id, author_name, content, is_resolved, created_at
    FROM comments
    WHERE file_id = ?
    ORDER BY line_number ASC, created_at ASC
  `),
  getCommentById: db.prepare(`
    SELECT id, project_id, file_id, line_number, author_id, author_name, content, is_resolved, created_at
    FROM comments
    WHERE id = ?
  `),
  updateCommentResolved: db.prepare(`
    UPDATE comments
    SET is_resolved = ?
    WHERE id = ?
  `),
  deleteComment: db.prepare(`
    DELETE FROM comments
    WHERE id = ?
  `),

  // Security Logs
  insertSecurityLog: db.prepare(`
    INSERT INTO security_logs (id, project_id, user_id, username, event_type, severity, details, blocked, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getSecurityLogs: db.prepare(`
    SELECT id, project_id, user_id, username, event_type, severity, details, blocked, created_at
    FROM security_logs
    ORDER BY created_at DESC
    LIMIT ?
  `),
  getSecurityLogsByProject: db.prepare(`
    SELECT id, project_id, user_id, username, event_type, severity, details, blocked, created_at
    FROM security_logs
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `)
};

// 3. Typed Data Access Layer with Prepared Statements

export function createUser(
  id: string,
  username: string,
  email?: string,
  passwordHash?: string,
  salt?: string,
  avatarColor?: string,
  avatarUrl?: string
): User {
  const createdAt = new Date().toISOString();
  stmts.insertUser.run(
    id,
    username,
    email || null,
    passwordHash || null,
    salt || null,
    avatarColor || null,
    avatarUrl || null,
    createdAt
  );
  return {
    id,
    username,
    email: email || undefined,
    password_hash: passwordHash || undefined,
    salt: salt || undefined,
    avatar_color: avatarColor || undefined,
    avatar_url: avatarUrl || undefined,
    created_at: createdAt
  };
}

export function getUserById(id: string): User | null {
  const row = stmts.getUserById.get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    password_hash: row.password_hash,
    salt: row.salt,
    avatar_color: row.avatar_color,
    avatar_url: row.avatar_url,
    created_at: row.created_at
  };
}

export function getUserByUsername(username: string): User | null {
  const row = stmts.getUserByUsername.get(username) as any;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    password_hash: row.password_hash,
    salt: row.salt,
    avatar_color: row.avatar_color,
    avatar_url: row.avatar_url,
    created_at: row.created_at
  };
}

export function getUserByEmail(email: string): User | null {
  const row = stmts.getUserByEmail.get(email) as any;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    password_hash: row.password_hash,
    salt: row.salt,
    avatar_color: row.avatar_color,
    avatar_url: row.avatar_url,
    created_at: row.created_at
  };
}

export function getUserByIdentifier(identifier: string): User | null {
  const row = stmts.getUserByIdentifier.get(identifier, identifier) as any;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    password_hash: row.password_hash,
    salt: row.salt,
    avatar_color: row.avatar_color,
    avatar_url: row.avatar_url,
    created_at: row.created_at
  };
}

export function createProject(
  id: string,
  name: string,
  description: string,
  inviteCode: string,
  ownerId: string
): Project {
  const createdAt = new Date().toISOString();
  stmts.insertProject.run(id, name, description, inviteCode, ownerId, createdAt);
  return {
    id,
    name,
    description,
    invite_code: inviteCode,
    owner_id: ownerId,
    created_at: createdAt,
    role: 'OWNER'
  };
}

export function getProjectById(id: string): Project | null {
  const row = stmts.getProjectById.get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    invite_code: row.invite_code,
    owner_id: row.owner_id,
    created_at: row.created_at
  };
}

export function getProjectByInviteCode(inviteCode: string): Project | null {
  const row = stmts.getProjectByInviteCode.get(inviteCode) as any;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    invite_code: row.invite_code,
    owner_id: row.owner_id,
    created_at: row.created_at
  };
}

export function getUserProjects(userId: string): Project[] {
  const rows = stmts.getUserProjects.all(userId) as any[];
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    invite_code: r.invite_code,
    owner_id: r.owner_id,
    created_at: r.created_at,
    role: r.role as CollaboratorRole
  }));
}

export function addProjectMember(
  id: string,
  projectId: string,
  userId: string,
  role: CollaboratorRole
): ProjectMember {
  const joinedAt = new Date().toISOString();
  stmts.insertMember.run(id, projectId, userId, role, joinedAt);
  const user = getUserById(userId);
  return {
    id,
    project_id: projectId,
    user_id: userId,
    role,
    joined_at: joinedAt,
    username: user?.username
  };
}

export function getProjectMember(projectId: string, userId: string): ProjectMember | null {
  const row = stmts.getMember.get(projectId, userId) as any;
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    user_id: row.user_id,
    role: row.role as CollaboratorRole,
    joined_at: row.joined_at,
    username: row.username
  };
}

export function getProjectMembers(projectId: string): ProjectMember[] {
  const rows = stmts.getMembersByProject.all(projectId) as any[];
  return rows.map(r => ({
    id: r.id,
    project_id: r.project_id,
    user_id: r.user_id,
    role: r.role as CollaboratorRole,
    joined_at: r.joined_at,
    username: r.username
  }));
}

export function updateProjectMemberRole(projectId: string, userId: string, role: CollaboratorRole): boolean {
  const result = stmts.updateMemberRole.run(role, projectId, userId);
  return result.changes > 0;
}

export function removeProjectMember(projectId: string, userId: string): boolean {
  const result = stmts.removeMember.run(projectId, userId);
  return result.changes > 0;
}

export function createFile(
  id: string,
  projectId: string,
  name: string,
  language: string,
  content: string,
  yjsState: Buffer | null = null
): ProjectFile {
  const now = new Date().toISOString();
  stmts.insertFile.run(id, projectId, name, language, content, yjsState, now, now);
  return {
    id,
    project_id: projectId,
    name,
    language,
    content,
    yjs_state: yjsState,
    created_at: now,
    updated_at: now
  };
}

export function getProjectFiles(projectId: string): ProjectFile[] {
  const rows = stmts.getFilesByProject.all(projectId) as any[];
  return rows.map(r => ({
    id: r.id,
    project_id: r.project_id,
    name: r.name,
    language: r.language,
    content: r.content,
    yjs_state: r.yjs_state,
    created_at: r.created_at,
    updated_at: r.updated_at
  }));
}

export function getFileById(id: string): ProjectFile | null {
  const row = stmts.getFileById.get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    language: row.language,
    content: row.content,
    yjs_state: row.yjs_state,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function getFileByName(projectId: string, name: string): ProjectFile | null {
  const row = stmts.getFileByName.get(projectId, name) as any;
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    language: row.language,
    content: row.content,
    yjs_state: row.yjs_state,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function updateFileContent(id: string, content: string, yjsState: Buffer | null = null): boolean {
  const now = new Date().toISOString();
  const result = stmts.updateFileContent.run(content, yjsState, now, id);
  return result.changes > 0;
}

export function updateFileDetails(
  id: string,
  name: string,
  language: string,
  content: string,
  yjsState: Buffer | null = null
): boolean {
  const now = new Date().toISOString();
  const result = stmts.updateFileDetails.run(name, language, content, yjsState, now, id);
  return result.changes > 0;
}

export function deleteFile(id: string): boolean {
  const result = stmts.deleteFile.run(id);
  return result.changes > 0;
}

export function createSnapshot(
  id: string,
  projectId: string,
  name: string,
  createdBy: string,
  filesJson: string
): VersionSnapshot {
  const createdAt = new Date().toISOString();
  stmts.insertSnapshot.run(id, projectId, name, createdBy, filesJson, createdAt);
  const user = getUserById(createdBy);
  return {
    id,
    project_id: projectId,
    name,
    created_by: createdBy,
    creator_name: user?.username,
    files: JSON.parse(filesJson),
    created_at: createdAt
  };
}

export function getSnapshotsByProject(projectId: string): VersionSnapshot[] {
  const rows = stmts.getSnapshotsByProject.all(projectId) as any[];
  return rows.map(r => ({
    id: r.id,
    project_id: r.project_id,
    name: r.name,
    created_by: r.created_by,
    creator_name: r.creator_name,
    files: JSON.parse(r.files_json),
    created_at: r.created_at
  }));
}

export function getSnapshotById(id: string): VersionSnapshot | null {
  const row = stmts.getSnapshotById.get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    created_by: row.created_by,
    creator_name: row.creator_name,
    files: JSON.parse(row.files_json),
    created_at: row.created_at
  };
}

export function createComment(
  id: string,
  projectId: string,
  fileId: string,
  lineNumber: number,
  authorId: string,
  authorName: string,
  content: string
): InlineComment {
  const createdAt = new Date().toISOString();
  stmts.insertComment.run(id, projectId, fileId, lineNumber, authorId, authorName, content, 0, createdAt);
  return {
    id,
    project_id: projectId,
    file_id: fileId,
    line_number: lineNumber,
    author_id: authorId,
    author_name: authorName,
    content,
    is_resolved: false,
    created_at: createdAt
  };
}

export function getCommentsByProject(projectId: string): InlineComment[] {
  const rows = stmts.getCommentsByProject.all(projectId) as any[];
  return rows.map(r => ({
    id: r.id,
    project_id: r.project_id,
    file_id: r.file_id,
    line_number: r.line_number,
    author_id: r.author_id,
    author_name: r.author_name,
    content: r.content,
    is_resolved: Boolean(r.is_resolved),
    created_at: r.created_at
  }));
}

export function getCommentsByFile(fileId: string): InlineComment[] {
  const rows = stmts.getCommentsByFile.all(fileId) as any[];
  return rows.map(r => ({
    id: r.id,
    project_id: r.project_id,
    file_id: r.file_id,
    line_number: r.line_number,
    author_id: r.author_id,
    author_name: r.author_name,
    content: r.content,
    is_resolved: Boolean(r.is_resolved),
    created_at: r.created_at
  }));
}

export function getCommentById(id: string): InlineComment | null {
  const row = stmts.getCommentById.get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    file_id: row.file_id,
    line_number: row.line_number,
    author_id: row.author_id,
    author_name: row.author_name,
    content: row.content,
    is_resolved: Boolean(row.is_resolved),
    created_at: row.created_at
  };
}

export function updateCommentResolved(id: string, isResolved: boolean): boolean {
  const result = stmts.updateCommentResolved.run(isResolved ? 1 : 0, id);
  return result.changes > 0;
}

export function deleteComment(id: string): boolean {
  const result = stmts.deleteComment.run(id);
  return result.changes > 0;
}

export function logSecurityEvent(event: {
  id?: string;
  project_id?: string | null;
  user_id?: string | null;
  username?: string | null;
  event_type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  details: string;
  blocked?: boolean | number;
}): SecurityEvent {
  const id = event.id || uuidv4();
  const createdAt = new Date().toISOString();
  const blockedInt = event.blocked ? 1 : 0;
  stmts.insertSecurityLog.run(
    id,
    event.project_id || null,
    event.user_id || null,
    event.username || null,
    event.event_type,
    event.severity,
    event.details,
    blockedInt,
    createdAt
  );

  return {
    id,
    project_id: event.project_id || null,
    user_id: event.user_id || null,
    username: event.username || null,
    event_type: event.event_type,
    severity: event.severity,
    details: event.details,
    blocked: Boolean(blockedInt),
    created_at: createdAt
  };
}

export function getSecurityLogs(projectId?: string, limit: number = 50): SecurityEvent[] {
  const rows = projectId
    ? (stmts.getSecurityLogsByProject.all(projectId, limit) as any[])
    : (stmts.getSecurityLogs.all(limit) as any[]);

  return rows.map(r => ({
    id: r.id,
    project_id: r.project_id,
    user_id: r.user_id,
    username: r.username,
    event_type: r.event_type,
    severity: r.severity as any,
    details: r.details,
    blocked: Boolean(r.blocked),
    created_at: r.created_at
  }));
}

// 4. Seed Seed Initial Demo Project ("Quantum Router Engine")
function seedDatabase() {
  const adminId = 'user-admin-default';
  const adminEmail = 'admin@devcollab.io';
  const adminUsername = 'Admin';
  const adminColor = '#00F0FF';

  let adminUser = getUserByEmail(adminEmail) || getUserById(adminId);
  if (!adminUser) {
    const { salt, hash } = hashPassword('Password@123');
    adminUser = createUser(
      adminId,
      adminUsername,
      adminEmail,
      hash,
      salt,
      adminColor,
      'https://api.dicebear.com/7.x/bottts/svg?seed=Admin'
    );
  }

  // Seed Users
  const aliceId = 'user-alice-lead';
  const bobId = 'user-bob-dev';

  if (!getUserById(aliceId) && !getUserByEmail('alice@devcollab.io')) {
    const { salt, hash } = hashPassword('Password@123');
    createUser(
      aliceId,
      'Alice (Quantum Lead)',
      'alice@devcollab.io',
      hash,
      salt,
      '#FFB800',
      'https://api.dicebear.com/7.x/bottts/svg?seed=Alice'
    );
  }
  if (!getUserById(bobId) && !getUserByEmail('bob@devcollab.io')) {
    const { salt, hash } = hashPassword('Password@123');
    createUser(
      bobId,
      'Bob (Crypto Dev)',
      'bob@devcollab.io',
      hash,
      salt,
      '#00F0FF',
      'https://api.dicebear.com/7.x/bottts/svg?seed=Bob'
    );
  }

  const demoProjectId = 'demo-quantum-router';
  const existingProject = getProjectById(demoProjectId);
  if (existingProject) {
    // Ensure admin user is attached as OWNER member of the demo project
    const adminMember = getProjectMember(demoProjectId, adminId);
    if (!adminMember) {
      addProjectMember(uuidv4(), demoProjectId, adminId, 'OWNER');
    }
    return;
  }

  // Seed Demo Project
  createProject(
    demoProjectId,
    'Quantum Router Engine',
    'Distributed packet routing simulation using quantum graph state optimization and CRDT synchronization.',
    'QUANTUM2025',
    adminId
  );

  // Assign Project Members
  addProjectMember(uuidv4(), demoProjectId, adminId, 'OWNER');
  addProjectMember(uuidv4(), demoProjectId, aliceId, 'EDITOR');
  addProjectMember(uuidv4(), demoProjectId, bobId, 'EDITOR');

  // Seed Starter File 1: main.py
  const mainPyContent = `"""
Quantum Router Engine - Core Simulation Kernel
Simulates Bell state distribution, fidelity decay, and entanglement swapping across nodes.
"""

import math
import random
import time
from typing import Dict, List, Tuple

class QuantumNode:
    def __init__(self, node_id: str, capacity: int = 16):
        self.node_id = node_id
        self.capacity = capacity
        self.qubits_in_use = 0
        self.coherence_time_us = 120.0  # microseconds

    def allocate_qubit(self) -> bool:
        if self.qubits_in_use < self.capacity:
            self.qubits_in_use += 1
            return True
        return False

    def release_qubit(self) -> None:
        if self.qubits_in_use > 0:
            self.qubits_in_use -= 1

class QuantumRouterEngine:
    def __init__(self):
        self.nodes: Dict[str, QuantumNode] = {
            "Node-Alpha": QuantumNode("Node-Alpha", 32),
            "Node-Beta": QuantumNode("Node-Beta", 32),
            "Node-Gamma": QuantumNode("Node-Gamma", 16),
            "Node-Delta": QuantumNode("Node-Delta", 16),
        }
        self.routing_table: Dict[Tuple[str, str], List[str]] = {
            ("Node-Alpha", "Node-Delta"): ["Node-Alpha", "Node-Beta", "Node-Gamma", "Node-Delta"],
            ("Node-Alpha", "Node-Gamma"): ["Node-Alpha", "Node-Beta", "Node-Gamma"],
        }

    def compute_fidelity(self, distance_km: float, attenuation_db_km: float = 0.2) -> float:
        transmissivity = 10.0 ** (-(attenuation_db_km * distance_km) / 10.0)
        base_fidelity = 0.99
        fidelity = base_fidelity * (0.5 + 0.5 * transmissivity)
        return max(0.5, min(1.0, fidelity))

    def simulate_entanglement_swap(self, source: str, target: str) -> Dict[str, any]:
        path = self.routing_table.get((source, target), [source, target])
        print(f"[QuantumEngine] Establishing entanglement between {source} and {target}")
        print(f"[QuantumEngine] Active hop path: {' -> '.join(path)}")

        hops = len(path) - 1
        link_distance = 25.0
        cumulative_fidelity = 1.0

        for i in range(hops):
            hop_src = path[i]
            hop_dst = path[i + 1]
            self.nodes[hop_src].allocate_qubit()
            self.nodes[hop_dst].allocate_qubit()
            link_fid = self.compute_fidelity(link_distance)
            cumulative_fidelity *= link_fid * 0.98
            print(f"  + Link {hop_src} <-> {hop_dst}: Fidelity={link_fid:.4f}")

        success = cumulative_fidelity >= 0.70
        return {
            "source": source,
            "target": target,
            "hops": hops,
            "fidelity": round(cumulative_fidelity, 4),
            "state": "|Phi+>" if success else "DECOHERED",
            "success": success,
            "timestamp": time.time()
        }

if __name__ == "__main__":
    engine = QuantumRouterEngine()
    result = engine.simulate_entanglement_swap("Node-Alpha", "Node-Delta")
    print(f"\\nFinal Entanglement Swap Result: {result}")
`;

  // Seed Starter File 2: algorithm.js
  const algorithmJsContent = `/**
 * Quantum Router Engine - Bell State Distribution & Dijkstra Optimization
 * Handles deterministic shortest-path entanglement routing.
 */

class BellPair {
  constructor(id, nodeA, nodeB, fidelity = 0.96) {
    this.id = id;
    this.nodeA = nodeA;
    this.nodeB = nodeB;
    this.fidelity = fidelity;
    this.createdAt = Date.now();
  }

  isDecohered(timeoutMs = 500) {
    return Date.now() - this.createdAt > timeoutMs;
  }
}

class RoutingMesh {
  constructor() {
    this.adjacency = new Map();
  }

  addLink(nodeA, nodeB, latencyMs, baseFidelity) {
    if (!this.adjacency.has(nodeA)) this.adjacency.set(nodeA, []);
    if (!this.adjacency.has(nodeB)) this.adjacency.set(nodeB, []);

    this.adjacency.get(nodeA).push({ target: nodeB, weight: latencyMs, fidelity: baseFidelity });
    this.adjacency.get(nodeB).push({ target: nodeA, weight: latencyMs, fidelity: baseFidelity });
  }

  findOptimalRoute(source, destination) {
    const distances = new Map();
    const previous = new Map();
    const unvisited = new Set();

    for (const node of this.adjacency.keys()) {
      distances.set(node, Infinity);
      unvisited.add(node);
    }

    distances.set(source, 0);

    while (unvisited.size > 0) {
      let current = null;
      for (const node of unvisited) {
        if (!current || distances.get(node) < distances.get(current)) {
          current = node;
        }
      }

      if (current === destination || distances.get(current) === Infinity) {
        break;
      }

      unvisited.delete(current);

      const neighbors = this.adjacency.get(current) || [];
      for (const neighbor of neighbors) {
        if (!unvisited.has(neighbor.target)) continue;
        const cost = distances.get(current) + neighbor.weight;
        if (cost < distances.get(neighbor.target)) {
          distances.set(neighbor.target, cost);
          previous.set(neighbor.target, current);
        }
      }
    }

    const path = [];
    let curr = destination;
    while (curr) {
      path.unshift(curr);
      curr = previous.get(curr);
    }

    return {
      source,
      destination,
      path: path[0] === source ? path : [],
      totalLatencyMs: distances.get(destination)
    };
  }
}

const mesh = new RoutingMesh();
mesh.addLink('Node-Alpha', 'Node-Beta', 12, 0.98);
mesh.addLink('Node-Beta', 'Node-Gamma', 15, 0.95);
mesh.addLink('Node-Gamma', 'Node-Delta', 10, 0.97);
mesh.addLink('Node-Alpha', 'Node-Gamma', 35, 0.90);

const optimalRoute = mesh.findOptimalRoute('Node-Alpha', 'Node-Delta');
console.log('Calculated Optimal Quantum Route:', JSON.stringify(optimalRoute, null, 2));

module.exports = { BellPair, RoutingMesh };
`;

  // Seed Starter File 3: README.md
  const readmeContent = `# Quantum Router Engine

Distributed quantum packet routing simulation using graph state optimization and CRDT synchronization.

## Architecture Overview
- **Core Engine (\`main.py\`)**: Python simulation calculating quantum state transitions, entanglement swapping fidelity decay, and qubit buffer allocation.
- **Routing Mesh (\`algorithm.js\`)**: Dynamic graph pathfinding minimizing latency and decoherence probability across quantum network repeaters.
- **Real-Time CRDT Sync**: Integrated with DevCollab Yjs CRDT synchronization for concurrent multi-engineer code editing.

## Security Constraints
- All code runs inside restricted sandbox environments with memory bounds and timeout enforcement.
- Strict RBAC: Only \`OWNER\` and \`EDITOR\` roles can edit files or trigger builds. \`VIEWER\` role is read-only.
- Path traversal and malicious process injection attempts (\`child_process\`, \`os.system\`, etc.) are actively monitored and logged in the Security Audit Log.
`;

  createFile(uuidv4(), demoProjectId, 'main.py', 'python', mainPyContent);
  createFile(uuidv4(), demoProjectId, 'algorithm.js', 'javascript', algorithmJsContent);
  createFile(uuidv4(), demoProjectId, 'README.md', 'markdown', readmeContent);

  // Seed 2 Initial Security Logs
  logSecurityEvent({
    id: 'sec-log-seed-1',
    project_id: demoProjectId,
    user_id: bobId,
    username: 'Bob (Crypto Dev)',
    event_type: 'UNAUTHORIZED_ACCESS_ATTEMPT',
    severity: 'MEDIUM',
    details: 'Access denied to project settings: insufficient role (VIEWER attempting schema mutation)',
    blocked: 1
  });

  logSecurityEvent({
    id: 'sec-log-seed-2',
    project_id: demoProjectId,
    user_id: 'unknown-intruder',
    username: 'external_probe',
    event_type: 'CODE_INJECTION_DETECTED',
    severity: 'HIGH',
    details: 'Threat pattern "os.system" detected in code submission for runner',
    blocked: 1
  });
}

// Execute initial seed
seedDatabase();
