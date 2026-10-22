import React, { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  Code2,
  Terminal,
  Layers,
  GitBranch,
  Play,
  Copy,
  Check,
  ChevronLeft,
  Shield,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Zap,
  Activity,
  Users,
  Flame,
  X,
  Sparkles,
  BookmarkPlus,
  Loader2,
  Radio,
  FileCode,
  Lock,
  LogOut
} from 'lucide-react';

import {
  AttackResult,
  Breakpoint,
  CollaboratorRole,
  CursorPosition,
  ExecutionResult,
  Project,
  ProjectFile,
  ProjectMember,
  SecurityEvent,
  User
} from './types';

import {
  authAPI,
  getStoredToken,
  getStoredUser,
  fetchProjectFiles,
  getProjectDetails,
  createSnapshot,
  executeCode,
  cn
} from './services/api';

import { AuthScreen } from './components/AuthScreen';
import { Dashboard } from './components/Dashboard';
import { SidebarFileTree } from './components/SidebarFileTree';
import { CollaborativeEditor } from './components/CollaborativeEditor';
import { ExecutionConsole } from './components/ExecutionConsole';
import { CollabDrawer } from './components/CollabDrawer';
import { VersionHistoryModal } from './components/VersionHistoryModal';
import { TelemetryBar } from './components/TelemetryBar';

interface SecurityAlertToast {
  id: string;
  type: string;
  message: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  details?: string;
  threats?: string[];
  riskScore?: number;
  username?: string;
  timestamp: string;
}

export const App: React.FC = () => {
  // ─── Authentication & Session State ─────────────────────────────────────────
  const [currentUser, setCurrentUser] = useState<User | null>(() => getStoredUser());
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  const [authChecking, setAuthChecking] = useState<boolean>(true);

  // ─── Project & File State ──────────────────────────────────────────────────
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [currentFile, setCurrentFile] = useState<ProjectFile | null>(null);
  const [liveCode, setLiveCode] = useState<string>('');

  // ─── Socket & Real-Time Collaboration State ────────────────────────────────
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [activePeers, setActivePeers] = useState<CursorPosition[]>([]);
  const [breakpoints, setBreakpoints] = useState<Map<string, Breakpoint>>(new Map());

  // ─── Telemetry & Simulation State ──────────────────────────────────────────
  const [crdtOps, setCrdtOps] = useState<number>(42);
  const [yjsBytes, setYjsBytes] = useState<number>(3480);
  const [burstCount, setBurstCount] = useState<number>(0);

  // ─── UI Panels & Modals ────────────────────────────────────────────────────
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [showSnapshotModal, setShowSnapshotModal] = useState(false);
  const [newSnapshotName, setNewSnapshotName] = useState('');
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const [snapshotFeedback, setSnapshotFeedback] = useState<string | null>(null);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [runningCode, setRunningCode] = useState(false);

  // ─── Live Security Alert Toast ─────────────────────────────────────────────
  const securityToastRef = useRef<SecurityAlertToast | null>(null);
  const [securityToast, setSecurityToast] = useState<SecurityAlertToast | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshFilesRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // ─── Verify Session on Mount ───────────────────────────────────────────────
  useEffect(() => {
    let isMounted = true;

    const verifySession = async () => {
      const storedToken = getStoredToken();
      const storedUser = getStoredUser();

      if (!storedToken || !storedUser) {
        if (isMounted) {
          setToken(null);
          setCurrentUser(null);
          setAuthChecking(false);
        }
        return;
      }

      try {
        const { user } = await authAPI.getMe();
        if (isMounted) {
          setCurrentUser(user);
          setToken(storedToken);
        }
      } catch (err) {
        console.warn('[App] Session verification failed, gating app:', err);
        authAPI.logout();
        if (isMounted) {
          setToken(null);
          setCurrentUser(null);
        }
      } finally {
        if (isMounted) {
          setAuthChecking(false);
        }
      }
    };

    verifySession();
    return () => {
      isMounted = false;
    };
  }, []);

  // ─── Handle Auth Success ───────────────────────────────────────────────────
  const handleAuthSuccess = (user: User, newToken: string) => {
    setCurrentUser(user);
    setToken(newToken);
  };

  // ─── Handle Logout ─────────────────────────────────────────────────────────
  const handleLogout = () => {
    authAPI.logout();
    setToken(null);
    setCurrentUser(null);
    setSelectedProject(null);
    setCurrentFile(null);
    setFiles([]);
    if (socket) {
      socket.disconnect();
    }
  };

  // ─── Compute Effective User Role for Active Project ────────────────────────
  const currentUserRole: CollaboratorRole = (() => {
    if (!selectedProject || !currentUser) return 'VIEWER';
    if (selectedProject.owner_id === currentUser.id) return 'OWNER';
    const member = projectMembers.find((m) => m.user_id === currentUser.id);
    if (member) return member.role;
    return selectedProject.role || 'EDITOR';
  })();

  // ─── Socket.IO Connection Setup (JWT Authenticated) ────────────────────────
  useEffect(() => {
    if (!token || !currentUser) return;

    const socketUrl = 'http://localhost:4000';
    const newSocket = io(socketUrl, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });

    newSocket.on('connect', () => {
      console.log(`[Socket.IO] Connected to ${socketUrl} (id: ${newSocket.id})`);
      setIsConnected(true);

      if (selectedProject) {
        newSocket.emit('join-project', { projectId: selectedProject.id });
      }
    });

    newSocket.on('disconnect', (reason) => {
      console.warn('[Socket.IO] Disconnected:', reason);
      setIsConnected(false);
    });

    newSocket.on('connect_error', (err) => {
      console.warn('[Socket.IO] Connection error:', err.message);
      setIsConnected(false);
    });

    // Handle incoming live security alerts
    newSocket.on('security-alert', (alert: any) => {
      const toastItem: SecurityAlertToast = {
        id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: alert.type || 'SECURITY_VIOLATION',
        message: alert.message || 'Security threat intercepted by DevCollab gateway.',
        severity: (alert.severity as SecurityAlertToast['severity']) || 'HIGH',
        details: alert.details || (alert.threats ? alert.threats.join(', ') : undefined),
        threats: alert.threats,
        riskScore: alert.riskScore,
        username: alert.username,
        timestamp: alert.timestamp || new Date().toISOString()
      };

      setSecurityToast(toastItem);

      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = setTimeout(() => {
        setSecurityToast(null);
      }, 8500);
    });

    // Handle peer cursor updates
    newSocket.on('peer-cursors', (peers: CursorPosition[]) => {
      setActivePeers(peers);
    });

    newSocket.on('cursor-update', (cursor: CursorPosition) => {
      setActivePeers((prev) => {
        const filtered = prev.filter((p) => p.userId !== cursor.userId);
        return [...filtered, cursor];
      });
    });

    newSocket.on('user-left', ({ userId }: { userId: string }) => {
      setActivePeers((prev) => prev.filter((p) => p.userId !== userId));
    });

    // Handle shared breakpoints
    newSocket.on('breakpoint-update', (data: { breakpoints?: Breakpoint[]; breakpoint?: Breakpoint }) => {
      if (data.breakpoints) {
        const nextMap = new Map<string, Breakpoint>();
        data.breakpoints.forEach((bp) => nextMap.set(bp.id, bp));
        setBreakpoints(nextMap);
      } else if (data.breakpoint) {
        setBreakpoints((prev) => {
          const next = new Map(prev);
          next.set(data.breakpoint!.id, data.breakpoint!);
          return next;
        });
      }
    });

    // Handle project membership broadcasts
    newSocket.on('project-members', (members: ProjectMember[]) => {
      setProjectMembers(members);
    });

    // Handle snapshot restored broadcast across all project collaborators
    newSocket.on('snapshot-restored', () => {
      refreshFilesRef.current();
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, [token, currentUser?.id]);

  // ─── Refresh Project Files ─────────────────────────────────────────────────
  const refreshFiles = useCallback(async () => {
    if (!selectedProject) return;
    try {
      const fileList = await fetchProjectFiles(selectedProject.id);
      setFiles(fileList);

      // Auto-select first file or retain currently active file
      if (fileList.length > 0) {
        setCurrentFile((prev) => {
          if (!prev) return fileList[0];
          const matched = fileList.find((f) => f.id === prev.id);
          return matched || fileList[0];
        });
      } else {
        setCurrentFile(null);
      }
    } catch (err) {
      console.error('[App] Failed to refresh files:', err);
    }
  }, [selectedProject]);
  refreshFilesRef.current = refreshFiles;

  // ─── Refresh Project Details & Members ─────────────────────────────────────
  const refreshProjectDetails = useCallback(async (projId: string) => {
    try {
      const { project, members } = await getProjectDetails(projId);
      setSelectedProject(project);
      setProjectMembers(members);
    } catch (err) {
      console.error('[App] Failed to fetch project details:', err);
    }
  }, []);

  // ─── When Project is Selected ──────────────────────────────────────────────
  const handleSelectProject = useCallback(
    async (project: Project) => {
      setSelectedProject(project);
      await refreshProjectDetails(project.id);
      await refreshFiles();

      if (socket && socket.connected) {
        socket.emit('join-project', { projectId: project.id });
      }
    },
    [refreshProjectDetails, refreshFiles, socket]
  );

  // ─── Sync Live Code When Current File Changes ──────────────────────────────
  useEffect(() => {
    if (currentFile) {
      setLiveCode(currentFile.content);
    } else {
      setLiveCode('');
    }
  }, [currentFile]);

  // ─── Copy Invite Code ──────────────────────────────────────────────────────
  const handleCopyInviteCode = () => {
    if (!selectedProject?.invite_code) return;
    navigator.clipboard.writeText(selectedProject.invite_code);
    setCopiedInvite(true);
    setTimeout(() => setCopiedInvite(false), 2000);
  };

  // ─── Save Snapshot ─────────────────────────────────────────────────────────
  const handleSaveSnapshot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProject || !newSnapshotName.trim()) return;

    setSavingSnapshot(true);
    setSnapshotFeedback(null);
    try {
      await createSnapshot(selectedProject.id, newSnapshotName.trim());
      setSnapshotFeedback('Snapshot saved successfully!');
      setTimeout(() => {
        setShowSnapshotModal(false);
        setNewSnapshotName('');
        setSnapshotFeedback(null);
      }, 1000);
    } catch (err: any) {
      setSnapshotFeedback(err.response?.data?.error || err.message || 'Failed to save snapshot');
    } finally {
      setSavingSnapshot(false);
    }
  };

  // ─── Run in Sandbox CTA ────────────────────────────────────────────────────
  const handleRunInSandbox = async () => {
    if (!selectedProject || !currentFile || currentUserRole === 'VIEWER') return;

    setRunningCode(true);
    try {
      const payloadCode = liveCode || currentFile.content;
      await executeCode(selectedProject.id, currentFile.id, payloadCode, currentFile.language);
    } catch (err) {
      console.error('[App] Execution failed:', err);
    } finally {
      setRunningCode(false);
    }
  };

  // ─── Helper: Role Badge Styling ────────────────────────────────────────────
  const getRoleRingClass = (role: CollaboratorRole) => {
    switch (role) {
      case 'OWNER':
        return 'ring-2 ring-[#FFB800] shadow-[0_0_10px_rgba(255,184,0,0.5)]';
      case 'EDITOR':
        return 'ring-2 ring-[#00F0FF] shadow-[0_0_10px_rgba(0,240,255,0.5)]';
      case 'VIEWER':
        return 'ring-2 ring-[#A855F7] shadow-[0_0_10px_rgba(168,85,247,0.5)]';
    }
  };

  const getRoleBadgeClass = (role: CollaboratorRole) => {
    switch (role) {
      case 'OWNER':
        return 'border-[#FFB800]/50 bg-[#FFB800]/10 text-[#FFB800]';
      case 'EDITOR':
        return 'border-[#00F0FF]/50 bg-[#00F0FF]/10 text-[#00F0FF]';
      case 'VIEWER':
        return 'border-[#A855F7]/50 bg-[#A855F7]/10 text-[#A855F7]';
    }
  };

  // ─── Loading Session Guard ─────────────────────────────────────────────────
  if (authChecking) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#090D16] text-cyan-400 font-sans select-none">
        <div className="flex flex-col items-center space-y-3">
          <div className="h-9 w-9 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
          <span className="font-mono text-xs text-slate-400">Verifying Zero-Trust Session...</span>
        </div>
      </div>
    );
  }

  // ─── Lock Down the App: Render AuthScreen if unauthenticated ────────────────
  if (!currentUser || !token) {
    return <AuthScreen onAuthSuccess={handleAuthSuccess} />;
  }

  // ─── If No Project Selected: Render Dashboard ──────────────────────────────
  if (!selectedProject) {
    return (
      <div className="flex h-screen w-screen flex-col bg-[#090D16] text-[#CBD7EE]">
        {/* Live Security Toast Banner (Visible also on Dashboard) */}
        {securityToast && (
          <div className="fixed top-4 right-4 z-50 max-w-md animate-in slide-in-from-top duration-300">
            <div
              className={cn(
                'rounded-lg border p-4 shadow-2xl backdrop-blur-md flex items-start space-x-3',
                securityToast.severity === 'CRITICAL' && 'border-rose-500/70 bg-rose-950/90 text-rose-100 shadow-rose-950/50',
                securityToast.severity === 'HIGH' && 'border-orange-500/70 bg-orange-950/90 text-orange-100 shadow-orange-950/50',
                securityToast.severity === 'MEDIUM' && 'border-amber-500/70 bg-amber-950/90 text-amber-100 shadow-amber-950/50',
                securityToast.severity === 'LOW' && 'border-blue-500/70 bg-blue-950/90 text-blue-100 shadow-blue-950/50'
              )}
            >
              <ShieldAlert className="h-5 w-5 flex-shrink-0 mt-0.5 text-rose-400" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-bold uppercase tracking-wider">
                    {securityToast.type}
                  </span>
                  <span className="rounded px-1.5 py-0.5 text-[9px] font-bold border border-current">
                    {securityToast.severity}
                  </span>
                </div>
                <p className="mt-1 text-xs font-medium leading-relaxed">{securityToast.message}</p>
                {securityToast.details && (
                  <p className="mt-1 text-[11px] opacity-80 font-mono break-all line-clamp-2">
                    {securityToast.details}
                  </p>
                )}
                {securityToast.username && (
                  <div className="mt-2 text-[10px] opacity-60">
                    Source: <span className="font-semibold">{securityToast.username}</span>
                  </div>
                )}
              </div>
              <button
                onClick={() => setSecurityToast(null)}
                className="text-slate-400 hover:text-white transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        <Dashboard
          onSelectProject={handleSelectProject}
          currentUser={currentUser}
          onLogout={handleLogout}
        />
      </div>
    );
  }

  // ─── IDE Workspace View ────────────────────────────────────────────────────
  return (
    <div className="flex h-screen w-screen flex-col bg-[#090D16] text-[#CBD7EE] overflow-hidden select-none">
      {/* ════════════════════════════════════════════════════════════════════════
          LIVE SECURITY TOAST BANNER (Cyber-Defense Interceptor)
          ════════════════════════════════════════════════════════════════════════ */}
      {securityToast && (
        <div className="fixed top-14 right-6 z-50 max-w-lg animate-in slide-in-from-top-4 duration-300">
          <div
            className={cn(
              'rounded-xl border p-4 shadow-[0_10px_35px_rgba(0,0,0,0.8)] backdrop-blur-xl flex items-start space-x-3.5',
              securityToast.severity === 'CRITICAL' && 'border-rose-500/80 bg-[#1A0A10]/95 text-rose-100 shadow-rose-950/60 ring-1 ring-rose-500/40',
              securityToast.severity === 'HIGH' && 'border-orange-500/80 bg-[#1A0E0A]/95 text-orange-100 shadow-orange-950/60 ring-1 ring-orange-500/40',
              securityToast.severity === 'MEDIUM' && 'border-amber-500/80 bg-[#1A140A]/95 text-amber-100 shadow-amber-950/60 ring-1 ring-amber-500/40',
              securityToast.severity === 'LOW' && 'border-blue-500/80 bg-[#0A101A]/95 text-blue-100 shadow-blue-950/60 ring-1 ring-blue-500/40'
            )}
          >
            <div className="rounded-lg p-2 bg-rose-500/20 border border-rose-500/40 flex-shrink-0">
              <ShieldAlert className="h-5 w-5 text-rose-400 animate-pulse" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between space-x-2">
                <div className="flex items-center space-x-2">
                  <span className="font-mono text-xs font-bold tracking-wide uppercase text-rose-300">
                    {securityToast.type}
                  </span>
                  <span className="rounded bg-rose-500/20 border border-rose-500/50 px-1.5 py-0.5 text-[9px] font-bold text-rose-300 uppercase">
                    BLOCKED
                  </span>
                </div>
                <span className="rounded px-1.5 py-0.5 text-[9px] font-bold border border-current opacity-90">
                  {securityToast.severity}
                </span>
              </div>
              <p className="mt-1 text-xs font-medium text-slate-100 leading-snug">
                {securityToast.message}
              </p>
              {securityToast.details && (
                <div className="mt-1.5 rounded border border-[#253554] bg-[#050810]/70 px-2 py-1 text-[11px] font-mono text-slate-300 break-all line-clamp-2">
                  {securityToast.details}
                </div>
              )}
              <div className="mt-2 flex items-center justify-between text-[10px] text-slate-400">
                <span>
                  Actor: <strong className="text-slate-200">{securityToast.username || 'unknown'}</strong>
                </span>
                <span>{new Date(securityToast.timestamp).toLocaleTimeString()}</span>
              </div>
            </div>
            <button
              onClick={() => setSecurityToast(null)}
              className="text-slate-400 hover:text-white transition-colors p-1 rounded hover:bg-slate-800"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          TOP IDE HEADER
          ════════════════════════════════════════════════════════════════════════ */}
      <header className="flex h-14 w-full flex-shrink-0 items-center justify-between border-b border-[#1E293B] bg-[#0B101E] px-4 shadow-sm z-30">
        {/* Left: Back Button, Brand, Project Title & Breadcrumb */}
        <div className="flex items-center space-x-3 min-w-0">
          <button
            onClick={() => setSelectedProject(null)}
            title="Back to Projects Dashboard"
            className="flex items-center space-x-1.5 rounded-lg border border-[#253554] bg-[#0F172A] px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-cyan-500/50 hover:bg-[#15233E] hover:text-cyan-400 transition-all"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Projects</span>
          </button>

          <div className="h-4 w-px bg-[#1E293B]" />

          <div className="flex items-center space-x-2 min-w-0">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-tr from-cyan-500 to-indigo-500 text-slate-950 font-bold shadow-md shadow-cyan-500/20">
              <Code2 className="h-4 w-4" />
            </div>
            <div className="flex items-baseline space-x-2 min-w-0 truncate">
              <h1 className="text-sm font-bold text-slate-100 truncate">
                {selectedProject.name}
              </h1>
              {currentFile && (
                <span className="hidden md:inline font-mono text-xs text-slate-500 truncate">
                  / {currentFile.name}
                </span>
              )}
            </div>
          </div>

          {/* Invite Code Copy Pill */}
          <button
            onClick={handleCopyInviteCode}
            title="Click to copy project invite code"
            className="flex items-center space-x-1.5 rounded-full border border-[#253554] bg-[#0E1527] px-2.5 py-1 text-[11px] font-mono text-slate-400 hover:border-cyan-500/40 hover:text-cyan-300 transition-all"
          >
            <span className="text-slate-600">Invite:</span>
            <span className="font-semibold text-slate-300">{selectedProject.invite_code}</span>
            {copiedInvite ? (
              <Check className="h-3.5 w-3.5 text-emerald-400 animate-in zoom-in" />
            ) : (
              <Copy className="h-3.5 w-3.5 text-slate-500" />
            )}
          </button>
        </div>

        {/* Center: Live Project Collaborators Avatar Stack */}
        <div className="hidden lg:flex items-center space-x-3">
          <div className="flex items-center space-x-1 text-xs text-slate-400 font-medium mr-1">
            <Users className="h-3.5 w-3.5 text-slate-500" />
            <span>Workspace Members</span>
          </div>

          <div className="flex items-center -space-x-2 overflow-visible">
            {projectMembers.map((m) => {
              const isSelf = m.user_id === currentUser.id;
              return (
                <div
                  key={m.id || m.user_id}
                  title={`${m.username || 'Collaborator'} (${m.role})${isSelf ? ' — (You)' : ''}`}
                  className="relative group cursor-pointer"
                >
                  <div
                    className={cn(
                      'h-8 w-8 rounded-full border-2 border-[#0B101E] flex items-center justify-center font-bold text-xs text-slate-950 transition-transform group-hover:scale-110 group-hover:z-10',
                      getRoleRingClass(m.role),
                      isSelf && 'scale-105 z-10'
                    )}
                    style={{
                      backgroundColor: isSelf
                        ? currentUser.avatar_color || '#00F0FF'
                        : m.role === 'OWNER'
                        ? '#FFB800'
                        : m.role === 'EDITOR'
                        ? '#00F0FF'
                        : '#A855F7'
                    }}
                  >
                    {(m.username || 'U').charAt(0).toUpperCase()}
                  </div>
                  <span
                    className={cn(
                      'absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-[#0B101E]',
                      m.role === 'OWNER' && 'bg-[#FFB800] shadow-[0_0_8px_#FFB800]',
                      m.role === 'EDITOR' && 'bg-[#00F0FF] shadow-[0_0_8px_#00F0FF]',
                      m.role === 'VIEWER' && 'bg-[#A855F7] shadow-[0_0_8px_#A855F7]'
                    )}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Actions CTA Buttons & User Profile / Logout */}
        <div className="flex items-center space-x-2">
          {/* Save Snapshot Button */}
          <button
            onClick={() => setShowSnapshotModal(true)}
            title="Create an immutable project snapshot"
            className="flex items-center space-x-1.5 rounded-lg border border-[#253554] bg-[#0E1527] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-500 hover:bg-[#172138] hover:text-white transition-all"
          >
            <BookmarkPlus className="h-3.5 w-3.5 text-indigo-400" />
            <span className="hidden sm:inline">Save Snapshot</span>
          </button>

          {/* Version Diff Button */}
          <button
            onClick={() => setShowVersionModal(true)}
            title="Inspect visual Monaco diffs and version history"
            className="flex items-center space-x-1.5 rounded-lg border border-[#253554] bg-[#0E1527] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-500 hover:bg-[#172138] hover:text-white transition-all"
          >
            <GitBranch className="h-3.5 w-3.5 text-cyan-400" />
            <span className="hidden sm:inline">Version Diff</span>
          </button>

          {/* Run in Sandbox CTA */}
          <button
            onClick={handleRunInSandbox}
            disabled={runningCode || !currentFile || currentUserRole === 'VIEWER'}
            title={
              currentUserRole === 'VIEWER'
                ? 'VIEWER accounts cannot execute code (RBAC enforced)'
                : 'Execute active code in zero-trust container'
            }
            className={cn(
              'flex items-center space-x-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-all shadow-md',
              currentUserRole === 'VIEWER'
                ? 'border border-[#253554] bg-slate-900 text-slate-500 cursor-not-allowed opacity-60'
                : 'border border-cyan-400/60 bg-gradient-to-r from-cyan-500 to-emerald-500 text-slate-950 hover:brightness-110 shadow-cyan-500/25 active:scale-95'
            )}
          >
            {runningCode ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5 fill-current" />
            )}
            <span>{runningCode ? 'Running…' : 'Run in Sandbox'}</span>
          </button>

          {/* Collab Drawer Toggle Button */}
          <button
            onClick={() => setDrawerOpen(!drawerOpen)}
            title="Toggle Collaboration Drawer (Chat, Breakpoints, SIEM, AI Co-Pilot)"
            className={cn(
              'flex items-center space-x-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all',
              drawerOpen
                ? 'border-cyan-500/60 bg-cyan-950/40 text-cyan-300'
                : 'border-[#253554] bg-[#0E1527] text-slate-300 hover:border-slate-500 hover:bg-[#172138]'
            )}
          >
            <Layers className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Collab Drawer</span>
          </button>

          {/* User Profile Pill & Logout Button */}
          <div className="flex items-center space-x-2 pl-2 border-l border-[#1E293B]">
            <div className="hidden sm:flex items-center space-x-2 rounded-lg border border-[#253554] bg-[#0E1527] px-2.5 py-1">
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px] text-slate-950 shadow-sm"
                style={{ backgroundColor: currentUser.avatar_color || '#00F0FF' }}
              >
                {currentUser.username.charAt(0).toUpperCase()}
              </div>
              <span className="text-xs font-semibold text-slate-200">{currentUser.username}</span>
              <span className={cn('rounded px-1.5 py-0.2 text-[9px] font-bold uppercase border', getRoleBadgeClass(currentUserRole))}>
                {currentUserRole}
              </span>
            </div>

            <button
              onClick={handleLogout}
              title="Sign out of DevCollab session"
              className="flex items-center space-x-1.5 rounded-lg border border-[#253554] bg-[#0E1527] px-2.5 py-1.5 text-xs font-medium text-slate-400 hover:border-rose-500/50 hover:bg-rose-950/40 hover:text-rose-300 transition-all shadow-sm"
            >
              <Lock className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Logout</span>
            </button>
          </div>
        </div>
      </header>

      {/* ════════════════════════════════════════════════════════════════════════
          MAIN WORKSPACE LAYOUT (Sidebar + Split Editor/Console + Drawer)
          ════════════════════════════════════════════════════════════════════════ */}
      <div className="flex flex-1 min-h-0 w-full overflow-hidden">
        {/* Left: Sidebar File Tree */}
        <SidebarFileTree
          projectId={selectedProject.id}
          projectName={selectedProject.name}
          userRole={currentUserRole}
          files={files}
          selectedFileId={currentFile?.id || null}
          onSelectFile={(f) => setCurrentFile(f)}
          onRefreshFiles={refreshFiles}
          activePeers={activePeers}
          collaborators={projectMembers}
          onBackToDashboard={() => setSelectedProject(null)}
        />

        {/* Center: Editor + Execution Console */}
        <main className="flex flex-1 min-w-0 flex-col overflow-hidden bg-[#050810]">
          {/* Top: Collaborative Monaco CRDT Editor */}
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {currentFile ? (
              <CollaborativeEditor
                file={currentFile}
                projectId={selectedProject.id}
                userId={currentUser.id}
                username={currentUser.username}
                userRole={currentUserRole}
                socket={socket}
                conflictBurstTrigger={burstCount}
                onCrdtOpsUpdate={(ops, bytes) => {
                  setCrdtOps((prev) => prev + ops);
                  setYjsBytes(bytes);
                }}
                onCodeChange={(code) => setLiveCode(code)}
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center space-y-3 text-slate-500">
                <FileCode className="h-12 w-12 stroke-[1.2] opacity-40" />
                <p className="text-sm font-medium">Select or create a file in the sidebar to begin editing.</p>
              </div>
            )}
          </div>

          {/* Bottom: Docked Zero-Trust Execution Console */}
          <ExecutionConsole
            projectId={selectedProject.id}
            fileId={currentFile?.id}
            fileName={currentFile?.name}
            code={liveCode || currentFile?.content}
            language={currentFile?.language || 'javascript'}
            userRole={currentUserRole}
            socket={socket}
            userId={currentUser.id}
            username={currentUser.username}
            onExecutionComplete={() => {}}
            initialCollapsed={false}
          />
        </main>

        {/* Right: Collaboration Drawer */}
        <CollabDrawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          projectId={selectedProject.id}
          currentFile={currentFile}
          userRole={currentUserRole}
          userId={currentUser.id}
          username={currentUser.username}
          socket={socket}
          breakpoints={breakpoints}
          liveCode={liveCode || currentFile?.content}
          language={currentFile?.language || 'javascript'}
        />
      </div>

      {/* ════════════════════════════════════════════════════════════════════════
          BOTTOM TELEMETRY & ATTACK SIMULATION BAR
          ════════════════════════════════════════════════════════════════════════ */}
      <TelemetryBar
        projectId={selectedProject.id}
        userRole={currentUserRole}
        username={currentUser.username}
        crdtOpsCount={crdtOps}
        yjsByteSize={yjsBytes}
        onSimulateBurst={() => setBurstCount((c) => c + 1)}
        onAttackSimulated={() => {}}
      />

      {/* ════════════════════════════════════════════════════════════════════════
          VERSION HISTORY & MONACO DIFF MODAL
          ════════════════════════════════════════════════════════════════════════ */}
      <VersionHistoryModal
        isOpen={showVersionModal}
        onClose={() => setShowVersionModal(false)}
        projectId={selectedProject.id}
        projectName={selectedProject.name}
        currentFile={currentFile}
        liveCode={liveCode || currentFile?.content || ''}
        userRole={currentUserRole}
        username={currentUser.username}
        socket={socket}
        onSnapshotRestored={refreshFiles}
      />

      {/* ════════════════════════════════════════════════════════════════════════
          CREATE SNAPSHOT DIALOG MODAL
          ════════════════════════════════════════════════════════════════════════ */}
      {showSnapshotModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-[#253554] bg-[#0B101E] p-6 shadow-2xl animate-in zoom-in-95">
            <div className="flex items-center justify-between pb-3 border-b border-[#1E293B]">
              <div className="flex items-center space-x-2">
                <BookmarkPlus className="h-5 w-5 text-indigo-400" />
                <h3 className="text-sm font-bold text-slate-100">Create Project Snapshot</h3>
              </div>
              <button
                onClick={() => setShowSnapshotModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveSnapshot} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  Snapshot Label / Tag
                </label>
                <input
                  type="text"
                  autoFocus
                  required
                  placeholder="e.g., v1.0.0-release, pre-refactor, quantum-stable"
                  value={newSnapshotName}
                  onChange={(e) => setNewSnapshotName(e.target.value)}
                  className="w-full rounded-lg border border-[#253554] bg-[#050810] px-3 py-2 text-xs text-slate-200 outline-none focus:border-indigo-500"
                />
              </div>

              {snapshotFeedback && (
                <div className="rounded-lg border border-[#253554] bg-[#050810] p-2.5 text-xs text-center font-medium text-cyan-300">
                  {snapshotFeedback}
                </div>
              )}

              <div className="flex items-center justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowSnapshotModal(false)}
                  className="rounded-lg border border-[#253554] px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingSnapshot || !newSnapshotName.trim()}
                  className="flex items-center space-x-1.5 rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {savingSnapshot && <Loader2 className="h-3 w-3 animate-spin" />}
                  <span>Save Snapshot</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
