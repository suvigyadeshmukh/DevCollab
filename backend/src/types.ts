import { Request } from 'express';

export type CollaboratorRole = 'OWNER' | 'EDITOR' | 'VIEWER';

export interface User {
  id: string;
  username: string;
  email?: string;
  password_hash?: string;
  salt?: string;
  avatar_color?: string;
  avatar_url?: string;
  created_at: string;
}

export interface UserTokenPayload {
  userId: string;
  username: string;
  email?: string;
  iat?: number;
  exp?: number;
}

export interface AuthenticatedRequest extends Request {
  user?: UserTokenPayload;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  invite_code: string;
  owner_id: string;
  created_at: string;
  role?: CollaboratorRole;
}

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  role: CollaboratorRole;
  joined_at: string;
  username?: string;
}

export interface ProjectFile {
  id: string;
  project_id: string;
  name: string;
  language: string;
  content: string;
  yjs_state?: Buffer | null;
  created_at: string;
  updated_at: string;
}

export interface SnapshotFileItem {
  name: string;
  language: string;
  content: string;
}

export interface VersionSnapshot {
  id: string;
  project_id: string;
  name: string;
  created_by: string;
  creator_name?: string;
  files: SnapshotFileItem[];
  created_at: string;
}

export interface InlineComment {
  id: string;
  project_id: string;
  file_id: string;
  line_number: number;
  author_id: string;
  author_name: string;
  content: string;
  is_resolved: boolean;
  created_at: string;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
  memoryUsageMb?: number;
  securityViolations?: string[];
}

export interface SecurityEvent {
  id: string;
  project_id?: string | null;
  user_id?: string | null;
  username?: string | null;
  event_type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  details: string;
  blocked: boolean;
  created_at: string;
}
