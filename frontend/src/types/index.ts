export type CollaboratorRole = 'OWNER' | 'EDITOR' | 'VIEWER';

export interface User {
  id: string;
  username: string;
  email?: string;
  avatar_color?: string;
  avatar_url?: string;
  created_at?: string;
}

export interface UserTokenPayload {
  userId: string;
  username: string;
  email?: string;
  iat?: number;
  exp?: number;
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
  avatar_url?: string;
}

export interface ProjectFile {
  id: string;
  project_id: string;
  name: string;
  language: string;
  content: string;
  yjs_state?: any;
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
  error?: string;
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

// ─── Frontend Real-Time & UI State Types ──────────────────────────────────────

export interface CursorPosition {
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

export interface Breakpoint {
  id: string;
  fileId: string;
  lineNumber: number;
  userId: string;
  username: string;
  enabled: boolean;
}

export interface ChatMessage {
  id: string;
  projectId: string;
  userId: string;
  username: string;
  content: string;
  timestamp: string;
}

export interface Persona {
  id: string;
  username: string;
  role: CollaboratorRole;
  avatarUrl: string;
  badgeColor: string;
  description: string;
}

export interface TelemetryState {
  jwtVerified: boolean;
  userRole: CollaboratorRole;
  crdtOpsCount: number;
  yjsByteSize: number;
  blockedIntrusionsCount: number;
  activePeersCount: number;
  latencyMs: number;
}

export type RedTeamAttackType = 'rce' | 'traversal' | 'rbac' | 'flood';

export interface AttackResult {
  type: RedTeamAttackType;
  blocked: boolean;
  status: number;
  message: string;
  details: string;
  timestamp: string;
}

export interface AIAssistRequest {
  prompt: string;
  codeSnippet: string;
  language: string;
}

export interface AIAssistResponse {
  suggestion: string;
  explanation: string;
  securityNotes?: string;
}
