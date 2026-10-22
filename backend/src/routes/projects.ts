import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  addProjectMember,
  createFile,
  createProject,
  createUser,
  getProjectById,
  getProjectByInviteCode,
  getProjectMember,
  getProjectMembers,
  getUserById,
  getUserByUsername,
  getUserProjects,
  logSecurityEvent,
  updateProjectMemberRole
} from '../db';
import { requireAuth, sanitizeText, signToken } from '../security/securityMiddleware';
import { AuthenticatedRequest, CollaboratorRole } from '../types';

export const projectsRouter = Router();

/**
 * POST /session
 * DEPRECATED: Insecure persona switcher endpoint removed for zero-trust email & password auth.
 */
projectsRouter.post('/session', (_req: AuthenticatedRequest, res: Response): void => {
  res.status(410).json({
    error: 'Endpoint Deprecated',
    message: 'The insecure persona session endpoint has been removed. Please authenticate via /api/auth/login or /api/auth/register.'
  });
});

/**
 * GET /
 * List all projects for authenticated user
 */
projectsRouter.get('/', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const userId = req.user!.userId;
    const projects = getUserProjects(userId);
    res.status(200).json({ projects });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch user projects', details: error.message });
  }
});

/**
 * POST /
 * Create a new project and assign caller as OWNER
 */
projectsRouter.post('/', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { name, description } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Project name is required' });
      return;
    }

    const sanitizedName = sanitizeText(name.trim(), 100);
    const sanitizedDesc = sanitizeText(typeof description === 'string' ? description.trim() : '', 500);
    const projectId = uuidv4();
    const inviteCode = `COLLAB-${uuidv4().substring(0, 8).toUpperCase()}`;
    const userId = req.user!.userId;

    const project = createProject(projectId, sanitizedName, sanitizedDesc, inviteCode, userId);
    addProjectMember(uuidv4(), projectId, userId, 'OWNER');

    // Create default README.md starter file
    createFile(
      uuidv4(),
      projectId,
      'README.md',
      'markdown',
      `# ${sanitizedName}\n\n${sanitizedDesc || 'Collaborative workspace initialized with DevCollab.'}\n`
    );

    res.status(201).json({
      project: {
        ...project,
        role: 'OWNER'
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to create project', details: error.message });
  }
});

/**
 * POST /join
 * Join an existing project via invite code
 */
projectsRouter.post('/join', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { invite_code } = req.body;
    if (!invite_code || typeof invite_code !== 'string' || !invite_code.trim()) {
      res.status(400).json({ error: 'Invite code is required' });
      return;
    }

    const project = getProjectByInviteCode(invite_code.trim());
    if (!project) {
      res.status(404).json({ error: 'Invalid invite code: project not found' });
      return;
    }

    const userId = req.user!.userId;
    const existingMember = getProjectMember(project.id, userId);

    if (existingMember) {
      res.status(200).json({
        message: 'Already a member of this project',
        project: {
          ...project,
          role: existingMember.role
        }
      });
      return;
    }

    // Default joined role is EDITOR
    const newRole: CollaboratorRole = 'EDITOR';
    addProjectMember(uuidv4(), project.id, userId, newRole);

    res.status(200).json({
      message: 'Joined project successfully',
      project: {
        ...project,
        role: newRole
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to join project', details: error.message });
  }
});

/**
 * PATCH /:projectId/role
 * OWNER only: modify collaborator role
 * Logs RBAC_VIOLATION_ATTEMPT if caller is not OWNER
 */
projectsRouter.patch('/:projectId/role', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { projectId } = req.params;
    const { userId: targetUserId, role: newRole } = req.body;
    const callerId = req.user!.userId;
    const callerUsername = req.user!.username;

    const project = getProjectById(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Role check in SQLite
    const callerMembership = getProjectMember(projectId, callerId);
    const isOwner = callerMembership?.role === 'OWNER' || project.owner_id === callerId;

    if (!isOwner) {
      logSecurityEvent({
        project_id: projectId,
        user_id: callerId,
        username: callerUsername,
        event_type: 'RBAC_VIOLATION_ATTEMPT',
        severity: 'HIGH',
        details: `User "${callerUsername}" (role: ${callerMembership?.role || 'NONE'}) attempted to alter role of user "${targetUserId}" to "${newRole}" without OWNER privileges`,
        blocked: 1
      });

      res.status(403).json({
        error: 'Forbidden: Only the project OWNER can modify collaborator roles'
      });
      return;
    }

    if (!targetUserId || typeof targetUserId !== 'string') {
      res.status(400).json({ error: 'Target user ID is required' });
      return;
    }

    const validRoles: CollaboratorRole[] = ['OWNER', 'EDITOR', 'VIEWER'];
    if (!validRoles.includes(newRole)) {
      res.status(400).json({ error: 'Invalid role. Valid options: OWNER, EDITOR, VIEWER' });
      return;
    }

    const targetMembership = getProjectMember(projectId, targetUserId);
    if (!targetMembership) {
      res.status(404).json({ error: 'Target user is not a member of this project' });
      return;
    }

    updateProjectMemberRole(projectId, targetUserId, newRole);

    res.status(200).json({
      message: 'Collaborator role updated successfully',
      projectId,
      userId: targetUserId,
      role: newRole
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update member role', details: error.message });
  }
});

/**
 * GET /:projectId
 * Fetch project details and membership
 */
projectsRouter.get('/:projectId', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { projectId } = req.params;
    const userId = req.user!.userId;

    const project = getProjectById(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const membership = getProjectMember(projectId, userId);
    if (!membership && project.owner_id !== userId) {
      logSecurityEvent({
        project_id: projectId,
        user_id: userId,
        username: req.user!.username,
        event_type: 'UNAUTHORIZED_ACCESS_ATTEMPT',
        severity: 'MEDIUM',
        details: `User "${req.user!.username}" attempted to view project "${projectId}" without membership`,
        blocked: 1
      });

      res.status(403).json({ error: 'Forbidden: You are not a member of this project' });
      return;
    }

    const members = getProjectMembers(projectId);

    res.status(200).json({
      project: {
        ...project,
        role: membership?.role || 'OWNER'
      },
      members
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch project details', details: error.message });
  }
});
