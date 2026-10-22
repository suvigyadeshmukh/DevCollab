import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  createComment,
  createFile,
  createSnapshot,
  db,
  deleteFile,
  getCommentById,
  getCommentsByFile,
  getCommentsByProject,
  getFileById,
  getFileByName,
  getProjectById,
  getProjectFiles,
  getProjectMember,
  getSnapshotById,
  getSnapshotsByProject,
  logSecurityEvent,
  updateCommentResolved,
  updateFileContent,
  updateFileDetails
} from '../db';
import { requireAuth, sanitizeText, validateSafeFilename } from '../security/securityMiddleware';
import { AuthenticatedRequest, CollaboratorRole, SnapshotFileItem } from '../types';

export const filesRouter = Router();

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'py':
      return 'python';
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'json':
      return 'json';
    case 'md':
      return 'markdown';
    case 'html':
      return 'html';
    case 'css':
      return 'css';
    case 'sql':
      return 'sql';
    case 'cpp':
    case 'cc':
    case 'cxx':
      return 'cpp';
    case 'c':
      return 'c';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'sh':
      return 'shell';
    case 'yaml':
    case 'yml':
      return 'yaml';
    default:
      return 'plaintext';
  }
}

/**
 * Check if the caller has sufficient role permissions
 */
function getCallerRole(projectId: string, userId: string): CollaboratorRole | null {
  const member = getProjectMember(projectId, userId);
  if (member) return member.role;

  const project = getProjectById(projectId);
  if (project && project.owner_id === userId) return 'OWNER';

  return null;
}

// ==========================================
// FILE CRUD ENDPOINTS
// ==========================================

/**
 * GET /:projectId
 * List all files in the project
 */
filesRouter.get('/:projectId', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { projectId } = req.params;
    const userId = req.user!.userId;

    const role = getCallerRole(projectId, userId);
    if (!role) {
      res.status(403).json({ error: 'Forbidden: You do not have access to this project' });
      return;
    }

    const files = getProjectFiles(projectId);
    res.status(200).json({ files });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch project files', details: error.message });
  }
});

/**
 * GET /:projectId/:fileId
 * Get specific file details
 */
filesRouter.get('/:projectId/:fileId', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { projectId, fileId } = req.params;
    const userId = req.user!.userId;

    const role = getCallerRole(projectId, userId);
    if (!role) {
      res.status(403).json({ error: 'Forbidden: You do not have access to this project' });
      return;
    }

    const file = getFileById(fileId);
    if (!file || file.project_id !== projectId) {
      res.status(404).json({ error: 'File not found in this project' });
      return;
    }

    res.status(200).json({ file });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch file', details: error.message });
  }
});

/**
 * POST /:projectId
 * Create a new file
 * Protected by requireAuth, RBAC check (block VIEWER), and validateSafeFilename
 */
filesRouter.post('/:projectId', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { projectId } = req.params;
    const { name, content, language } = req.body;
    const userId = req.user!.userId;
    const username = req.user!.username;

    const role = getCallerRole(projectId, userId);
    if (!role) {
      res.status(403).json({ error: 'Forbidden: You are not a member of this project' });
      return;
    }

    // RBAC check: Block VIEWER
    if (role === 'VIEWER') {
      logSecurityEvent({
        project_id: projectId,
        user_id: userId,
        username,
        event_type: 'RBAC_VIOLATION_ATTEMPT',
        severity: 'HIGH',
        details: `VIEWER "${username}" attempted unauthorized file creation: "${name}"`,
        blocked: 1
      });
      res.status(403).json({ error: 'Forbidden: VIEWER role cannot create files' });
      return;
    }

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'File name is required' });
      return;
    }

    const trimmedName = name.trim();

    // Validate safe filename (block path traversal, null bytes, dotfiles)
    if (!validateSafeFilename(trimmedName)) {
      logSecurityEvent({
        project_id: projectId,
        user_id: userId,
        username,
        event_type: 'PATH_TRAVERSAL_BLOCKED',
        severity: 'HIGH',
        details: `Blocked unsafe filename or path traversal attempt: "${trimmedName}"`,
        blocked: 1
      });
      res.status(400).json({
        error: 'Invalid or unsafe filename. Path traversal, null bytes, directory separators, and dotfiles are prohibited.'
      });
      return;
    }

    // Check duplicate filename in project
    const existingFile = getFileByName(projectId, trimmedName);
    if (existingFile) {
      res.status(409).json({ error: `A file named "${trimmedName}" already exists in this project` });
      return;
    }

    const fileLang = language && typeof language === 'string' ? language.trim() : detectLanguage(trimmedName);
    const fileContent = typeof content === 'string' ? content : '';
    const newFileId = uuidv4();

    const created = createFile(newFileId, projectId, trimmedName, fileLang, fileContent);

    res.status(201).json({ file: created });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to create file', details: error.message });
  }
});

/**
 * POST /:projectId/upload
 * Upload a file with content, language, and optional overwrite flag.
 * Protected by requireAuth, RBAC check (block VIEWER), validateSafeFilename, and size check.
 */
filesRouter.post('/:projectId/upload', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { projectId } = req.params;
    const { name, content, language, overwrite } = req.body;
    const userId = req.user!.userId;
    const username = req.user!.username;

    const role = getCallerRole(projectId, userId);
    if (!role) {
      res.status(403).json({ error: 'Forbidden: You are not a member of this project' });
      return;
    }

    // RBAC check: Block VIEWER
    if (role === 'VIEWER') {
      logSecurityEvent({
        project_id: projectId,
        user_id: userId,
        username,
        event_type: 'RBAC_VIOLATION_ATTEMPT',
        severity: 'HIGH',
        details: `VIEWER "${username}" attempted unauthorized file upload: "${name}"`,
        blocked: 1
      });
      res.status(403).json({ error: 'Forbidden: VIEWER role cannot upload files' });
      return;
    }

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'File name is required' });
      return;
    }

    const trimmedName = name.trim();

    // Validate safe filename (block path traversal, null bytes, dotfiles)
    if (!validateSafeFilename(trimmedName)) {
      logSecurityEvent({
        project_id: projectId,
        user_id: userId,
        username,
        event_type: 'PATH_TRAVERSAL_BLOCKED',
        severity: 'HIGH',
        details: `Blocked unsafe filename in upload: "${trimmedName}"`,
        blocked: 1
      });
      res.status(400).json({
        error: 'Invalid or unsafe filename. Path traversal, null bytes, directory separators, and dotfiles are prohibited.'
      });
      return;
    }

    // Size limit check (2MB max for text code source)
    const fileContent = typeof content === 'string' ? content : '';
    if (fileContent.length > 2 * 1024 * 1024) {
      res.status(413).json({ error: 'File exceeds maximum upload size limit of 2MB.' });
      return;
    }

    const fileLang = language && typeof language === 'string' ? language.trim() : detectLanguage(trimmedName);
    const existingFile = getFileByName(projectId, trimmedName);

    if (existingFile) {
      if (overwrite) {
        updateFileContent(existingFile.id, fileContent);
        const updated = getFileById(existingFile.id);
        res.status(200).json({ file: updated, overwritten: true, message: `Overwrote "${trimmedName}"` });
        return;
      } else {
        res.status(409).json({
          error: `A file named "${trimmedName}" already exists in this project`,
          fileId: existingFile.id,
          fileName: trimmedName,
          exists: true
        });
        return;
      }
    }

    const newFileId = uuidv4();
    const created = createFile(newFileId, projectId, trimmedName, fileLang, fileContent);

    res.status(201).json({ file: created, overwritten: false, message: `Uploaded "${trimmedName}" successfully` });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to upload file', details: error.message });
  }
});

/**
 * PUT /:projectId/:fileId
 * Update file content, metadata, or Yjs CRDT state
 * Protected by requireAuth, RBAC check (block VIEWER), and validateSafeFilename
 */
filesRouter.put('/:projectId/:fileId', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { projectId, fileId } = req.params;
    const { name, content, language, yjs_state } = req.body;
    const userId = req.user!.userId;
    const username = req.user!.username;

    const role = getCallerRole(projectId, userId);
    if (!role) {
      res.status(403).json({ error: 'Forbidden: You are not a member of this project' });
      return;
    }

    // RBAC check: Block VIEWER
    if (role === 'VIEWER') {
      logSecurityEvent({
        project_id: projectId,
        user_id: userId,
        username,
        event_type: 'RBAC_VIOLATION_ATTEMPT',
        severity: 'HIGH',
        details: `VIEWER "${username}" attempted unauthorized file modification for fileId "${fileId}"`,
        blocked: 1
      });
      res.status(403).json({ error: 'Forbidden: VIEWER role cannot edit files' });
      return;
    }

    const currentFile = getFileById(fileId);
    if (!currentFile || currentFile.project_id !== projectId) {
      res.status(404).json({ error: 'File not found in this project' });
      return;
    }

    let finalName = currentFile.name;
    if (name && typeof name === 'string' && name.trim() !== currentFile.name) {
      const trimmedName = name.trim();
      if (!validateSafeFilename(trimmedName)) {
        logSecurityEvent({
          project_id: projectId,
          user_id: userId,
          username,
          event_type: 'PATH_TRAVERSAL_BLOCKED',
          severity: 'HIGH',
          details: `Blocked rename to unsafe filename: "${trimmedName}"`,
          blocked: 1
        });
        res.status(400).json({
          error: 'Invalid or unsafe filename. Path traversal, null bytes, and dotfiles are prohibited.'
        });
        return;
      }

      const duplicate = getFileByName(projectId, trimmedName);
      if (duplicate && duplicate.id !== fileId) {
        res.status(409).json({ error: `A file named "${trimmedName}" already exists in this project` });
        return;
      }
      finalName = trimmedName;
    }

    const finalLanguage = language && typeof language === 'string' ? language.trim() : detectLanguage(finalName);
    const finalContent = typeof content === 'string' ? content : currentFile.content;

    let finalYjsState: Buffer | null = currentFile.yjs_state || null;
    if (yjs_state) {
      if (Buffer.isBuffer(yjs_state)) {
        finalYjsState = yjs_state;
      } else if (typeof yjs_state === 'string') {
        finalYjsState = Buffer.from(yjs_state, 'base64');
      }
    }

    updateFileDetails(fileId, finalName, finalLanguage, finalContent, finalYjsState);
    const updated = getFileById(fileId);

    res.status(200).json({ file: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update file', details: error.message });
  }
});

/**
 * DELETE /:projectId/:fileId
 * Delete a file
 * Protected by requireAuth, RBAC check (block VIEWER)
 */
filesRouter.delete('/:projectId/:fileId', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { projectId, fileId } = req.params;
    const userId = req.user!.userId;
    const username = req.user!.username;

    const role = getCallerRole(projectId, userId);
    if (!role) {
      res.status(403).json({ error: 'Forbidden: You are not a member of this project' });
      return;
    }

    // RBAC check: Block VIEWER
    if (role === 'VIEWER') {
      logSecurityEvent({
        project_id: projectId,
        user_id: userId,
        username,
        event_type: 'RBAC_VIOLATION_ATTEMPT',
        severity: 'HIGH',
        details: `VIEWER "${username}" attempted unauthorized file deletion for fileId "${fileId}"`,
        blocked: 1
      });
      res.status(403).json({ error: 'Forbidden: VIEWER role cannot delete files' });
      return;
    }

    const file = getFileById(fileId);
    if (!file || file.project_id !== projectId) {
      res.status(404).json({ error: 'File not found in this project' });
      return;
    }

    deleteFile(fileId);

    res.status(200).json({
      message: 'File deleted successfully',
      fileId,
      name: file.name
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete file', details: error.message });
  }
});

// ==========================================
// SNAPSHOT ENDPOINTS
// ==========================================

/**
 * POST /:projectId/snapshots
 * Create a point-in-time snapshot of the project
 */
filesRouter.post('/:projectId/snapshots', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { projectId } = req.params;
    const { name } = req.body;
    const userId = req.user!.userId;
    const username = req.user!.username;

    const role = getCallerRole(projectId, userId);
    if (!role) {
      res.status(403).json({ error: 'Forbidden: You are not a member of this project' });
      return;
    }

    if (role === 'VIEWER') {
      logSecurityEvent({
        project_id: projectId,
        user_id: userId,
        username,
        event_type: 'RBAC_VIOLATION_ATTEMPT',
        severity: 'HIGH',
        details: `VIEWER "${username}" attempted unauthorized snapshot creation`,
        blocked: 1
      });
      res.status(403).json({ error: 'Forbidden: VIEWER role cannot create snapshots' });
      return;
    }

    const rawName = typeof name === 'string' && name.trim() ? name.trim() : `Snapshot_${new Date().toISOString()}`;
    const sanitizedName = sanitizeText(rawName, 100);

    const files = getProjectFiles(projectId);
    const snapshotFiles: SnapshotFileItem[] = files.map(f => ({
      name: f.name,
      language: f.language,
      content: f.content
    }));

    const snapshotId = uuidv4();
    const snapshot = createSnapshot(
      snapshotId,
      projectId,
      sanitizedName,
      userId,
      JSON.stringify(snapshotFiles)
    );

    res.status(201).json({ snapshot });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to create snapshot', details: error.message });
  }
});

/**
 * GET /:projectId/snapshots
 * List all snapshots for a project
 */
filesRouter.get('/:projectId/snapshots', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { projectId } = req.params;
    const userId = req.user!.userId;

    const role = getCallerRole(projectId, userId);
    if (!role) {
      res.status(403).json({ error: 'Forbidden: You do not have access to this project' });
      return;
    }

    const snapshots = getSnapshotsByProject(projectId);
    res.status(200).json({ snapshots });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch snapshots', details: error.message });
  }
});

/**
 * POST /:projectId/snapshots/:snapshotId/restore
 * Restore the project file tree from a snapshot
 */
filesRouter.post('/:projectId/snapshots/:snapshotId/restore', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { projectId, snapshotId } = req.params;
    const userId = req.user!.userId;
    const username = req.user!.username;

    const role = getCallerRole(projectId, userId);
    if (!role) {
      res.status(403).json({ error: 'Forbidden: You do not have access to this project' });
      return;
    }

    if (role === 'VIEWER') {
      logSecurityEvent({
        project_id: projectId,
        user_id: userId,
        username,
        event_type: 'RBAC_VIOLATION_ATTEMPT',
        severity: 'HIGH',
        details: `VIEWER "${username}" attempted unauthorized snapshot restore`,
        blocked: 1
      });
      res.status(403).json({ error: 'Forbidden: VIEWER role cannot restore snapshots' });
      return;
    }

    const snapshot = getSnapshotById(snapshotId);
    if (!snapshot || snapshot.project_id !== projectId) {
      res.status(404).json({ error: 'Snapshot not found in this project' });
      return;
    }

    const snapshotFiles = snapshot.files;

    // Transactional restore: update existing files or create missing ones
    const restoreTx = db.transaction(() => {
      const currentFiles = getProjectFiles(projectId);
      const currentFileMap = new Map(currentFiles.map(f => [f.name, f]));

      for (const item of snapshotFiles) {
        const existing = currentFileMap.get(item.name);
        if (existing) {
          updateFileContent(existing.id, item.content, null);
        } else {
          createFile(uuidv4(), projectId, item.name, item.language, item.content, null);
        }
      }
    });

    restoreTx();

    res.status(200).json({
      message: 'Project successfully restored from snapshot',
      snapshotId,
      restoredFilesCount: snapshotFiles.length
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to restore snapshot', details: error.message });
  }
});

// ==========================================
// INLINE COMMENTS ENDPOINTS
// ==========================================

/**
 * GET /:projectId/comments
 * Fetch comments for the project or filtered by fileId
 */
filesRouter.get('/:projectId/comments', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { projectId } = req.params;
    const { fileId } = req.query;
    const userId = req.user!.userId;

    const role = getCallerRole(projectId, userId);
    if (!role) {
      res.status(403).json({ error: 'Forbidden: You do not have access to this project' });
      return;
    }

    const comments = fileId && typeof fileId === 'string'
      ? getCommentsByFile(fileId)
      : getCommentsByProject(projectId);

    res.status(200).json({ comments });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch comments', details: error.message });
  }
});

/**
 * POST /:projectId/comments
 * Add an inline comment (sanitized against Stored XSS)
 */
filesRouter.post('/:projectId/comments', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { projectId } = req.params;
    const { fileId, lineNumber, content } = req.body;
    const userId = req.user!.userId;
    const username = req.user!.username;

    const role = getCallerRole(projectId, userId);
    if (!role) {
      res.status(403).json({ error: 'Forbidden: You do not have access to this project' });
      return;
    }

    if (!fileId || typeof fileId !== 'string') {
      res.status(400).json({ error: 'File ID is required' });
      return;
    }

    const targetFile = getFileById(fileId);
    if (!targetFile || targetFile.project_id !== projectId) {
      res.status(404).json({ error: 'Target file not found in this project' });
      return;
    }

    const parsedLine = Number(lineNumber);
    if (isNaN(parsedLine) || parsedLine < 1) {
      res.status(400).json({ error: 'Valid line number (>= 1) is required' });
      return;
    }

    if (!content || typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'Comment content cannot be empty' });
      return;
    }

    // Sanitize against Stored XSS
    const sanitizedContent = sanitizeText(content.trim(), 2000);
    const commentId = uuidv4();

    const comment = createComment(
      commentId,
      projectId,
      fileId,
      parsedLine,
      userId,
      username,
      sanitizedContent
    );

    res.status(201).json({ comment });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to add comment', details: error.message });
  }
});

/**
 * PATCH /:projectId/comments/:commentId/resolve
 * Resolve or unresolve an inline comment
 */
filesRouter.patch('/:projectId/comments/:commentId/resolve', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { projectId, commentId } = req.params;
    const { isResolved } = req.body;
    const userId = req.user!.userId;

    const role = getCallerRole(projectId, userId);
    if (!role) {
      res.status(403).json({ error: 'Forbidden: You do not have access to this project' });
      return;
    }

    const comment = getCommentById(commentId);
    if (!comment || comment.project_id !== projectId) {
      res.status(404).json({ error: 'Comment not found in this project' });
      return;
    }

    const resolvedStatus = isResolved === undefined ? true : Boolean(isResolved);
    updateCommentResolved(commentId, resolvedStatus);

    res.status(200).json({
      message: 'Comment resolution status updated',
      commentId,
      isResolved: resolvedStatus
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update comment status', details: error.message });
  }
});
