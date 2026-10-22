import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import {
  MessageSquare,
  MessagesSquare,
  Bug,
  ShieldAlert,
  Sparkles,
  X,
  ChevronRight,
  Plus,
  Check,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Flame,
  Eye,
  EyeOff,
  Hash,
  Clock,
  User,
  Loader2,
  Lock,
  Send,
  Trash2,
  Code2,
  Activity,
  Crosshair,
  PlusCircle,
  MinusCircle,
  Shield,
  Zap,
  BookOpen,
  TestTube2,
  Wrench,
  SearchCode
} from 'lucide-react';
import {
  Breakpoint,
  ChatMessage,
  CollaboratorRole,
  InlineComment,
  ProjectFile,
  RedTeamAttackType,
  SecurityEvent,
  AttackResult,
  AIAssistResponse
} from '../types';
import {
  fetchComments,
  createComment,
  resolveComment,
  fetchSecurityLogs,
  simulateRedTeamAttack,
  requestAIAssist,
  cn
} from '../services/api';

// ─── Types ────────────────────────────────────────────────────────────────────

type DrawerTab = 'comments' | 'chat' | 'debugger' | 'siem' | 'ai';

interface CollabDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  currentFile: ProjectFile | null;
  userRole: CollaboratorRole;
  userId: string;
  username: string;
  socket: Socket | null;
  breakpoints: Map<string, Breakpoint>;
  onJumpToLine?: (lineNumber: number) => void;
  liveCode?: string;
  language?: string;
}

interface WatchExpression {
  id: string;
  expression: string;
  value: string;
  addedBy: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '';
  }
}

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHrs = Math.floor(diffMin / 60);
  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return new Date(iso).toLocaleDateString();
}

function getRoleBadgeClass(role: CollaboratorRole): string {
  return cn(
    'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase border',
    role === 'OWNER' && 'border-amber-600/60 bg-amber-950/40 text-amber-400',
    role === 'EDITOR' && 'border-cyan-700/60 bg-cyan-950/40 text-cyan-400',
    role === 'VIEWER' && 'border-violet-700/60 bg-violet-950/40 text-violet-400'
  );
}

function getSeverityClass(severity: string): string {
  switch (severity) {
    case 'CRITICAL':
      return 'border-rose-600/60 bg-rose-950/30 text-rose-300';
    case 'HIGH':
      return 'border-orange-600/60 bg-orange-950/30 text-orange-300';
    case 'MEDIUM':
      return 'border-amber-600/60 bg-amber-950/30 text-amber-300';
    case 'LOW':
    default:
      return 'border-slate-600/60 bg-slate-900/30 text-slate-400';
  }
}

function getEventIcon(eventType: string): React.ElementType {
  if (eventType.includes('SANDBOX') || eventType.includes('RCE')) return Flame;
  if (eventType.includes('TRAVERSAL') || eventType.includes('PATH')) return SearchCode;
  if (eventType.includes('RBAC') || eventType.includes('ROLE')) return Lock;
  if (eventType.includes('FLOOD') || eventType.includes('RATE')) return Zap;
  return ShieldAlert;
}

// ─── Tab Button ───────────────────────────────────────────────────────────────

const TabButton: React.FC<{
  tab: DrawerTab;
  active: DrawerTab;
  label: string;
  icon: React.ElementType;
  badge?: number | string;
  onClick: (t: DrawerTab) => void;
}> = ({ tab, active, label, icon: Icon, badge, onClick }) => (
  <button
    onClick={() => onClick(tab)}
    className={cn(
      'relative flex flex-col items-center justify-center px-2 py-1.5 text-[10px] font-medium transition-all rounded-sm flex-1 gap-0.5',
      active === tab
        ? 'bg-[#1E293B] text-slate-100'
        : 'text-slate-500 hover:text-slate-300 hover:bg-[#0F172A]'
    )}
  >
    <Icon className="h-4 w-4" />
    <span className="hidden sm:block">{label}</span>
    {badge !== undefined && badge !== 0 && (
      <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-rose-600 px-1 text-[9px] font-bold text-white">
        {badge}
      </span>
    )}
  </button>
);

// ─── Main Component ───────────────────────────────────────────────────────────

export const CollabDrawer: React.FC<CollabDrawerProps> = ({
  isOpen,
  onClose,
  projectId,
  currentFile,
  userRole,
  userId,
  username,
  socket,
  breakpoints,
  onJumpToLine,
  liveCode = '',
  language = 'typescript'
}) => {
  const [activeTab, setActiveTab] = useState<DrawerTab>('comments');
  const canWrite = userRole === 'OWNER' || userRole === 'EDITOR';

  // ── COMMENTS TAB ──────────────────────────────────────────────────────────
  const [comments, setComments] = useState<InlineComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [newCommentLine, setNewCommentLine] = useState<number | ''>('');
  const [newCommentText, setNewCommentText] = useState('');
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const loadComments = useCallback(async () => {
    if (!projectId) return;
    setCommentsLoading(true);
    try {
      const data = await fetchComments(projectId, currentFile?.id);
      setComments(data);
    } catch {
      /* silent */
    } finally {
      setCommentsLoading(false);
    }
  }, [projectId, currentFile?.id]);

  useEffect(() => {
    if (isOpen && activeTab === 'comments') {
      loadComments();
    }
  }, [isOpen, activeTab, loadComments]);

  // Listen for new-comment broadcasts
  useEffect(() => {
    if (!socket) return;
    const handler = (data: { comment: InlineComment }) => {
      setComments(prev => {
        if (prev.some(c => c.id === data.comment.id)) return prev;
        return [...prev, data.comment];
      });
    };
    socket.on('new-comment', handler);
    return () => { socket.off('new-comment', handler); };
  }, [socket]);

  const handleAddComment = async () => {
    if (!currentFile || !newCommentText.trim() || !newCommentLine) return;
    const line = Number(newCommentLine);
    if (isNaN(line) || line < 1) {
      setCommentError('Enter a valid line number.');
      return;
    }
    setCommentSubmitting(true);
    setCommentError(null);
    try {
      const comment = await createComment(projectId, currentFile.id, line, newCommentText.trim());
      setComments(prev => [...prev, comment]);
      setNewCommentText('');
      setNewCommentLine('');
      // Notify peers via socket
      if (socket?.connected) {
        socket.emit('new-comment', {
          projectId,
          fileId: currentFile.id,
          lineNumber: line,
          content: newCommentText.trim()
        });
      }
    } catch (err: any) {
      setCommentError(err.response?.data?.error ?? err.message ?? 'Failed to post comment.');
    } finally {
      setCommentSubmitting(false);
    }
  };

  const handleResolveComment = async (commentId: string, isResolved: boolean) => {
    setResolving(commentId);
    try {
      await resolveComment(projectId, commentId, isResolved);
      setComments(prev =>
        prev.map(c => c.id === commentId ? { ...c, is_resolved: isResolved } : c)
      );
    } catch {
      /* silent */
    } finally {
      setResolving(null);
    }
  };

  // Group by line number
  const filteredComments = comments.filter(c =>
    showResolved ? true : !c.is_resolved
  );
  const commentsByLine = filteredComments.reduce<Record<number, InlineComment[]>>((acc, c) => {
    if (!acc[c.line_number]) acc[c.line_number] = [];
    acc[c.line_number].push(c);
    return acc;
  }, {});
  const sortedLines = Object.keys(commentsByLine)
    .map(Number)
    .sort((a, b) => a - b);
  const unresolvedCount = comments.filter(c => !c.is_resolved).length;

  // ── CHAT TAB ──────────────────────────────────────────────────────────────
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!socket) return;

    const handleHistory = (data: { messages: ChatMessage[] }) => {
      setChatMessages(data.messages || []);
    };
    const handleMessage = (msg: ChatMessage) => {
      setChatMessages(prev => [...prev, msg]);
    };

    socket.on('chat-history', handleHistory);
    socket.on('chat-message', handleMessage);

    return () => {
      socket.off('chat-history', handleHistory);
      socket.off('chat-message', handleMessage);
    };
  }, [socket]);

  useEffect(() => {
    if (activeTab === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, activeTab]);

  const handleSendChat = () => {
    const content = chatInput.trim();
    if (!content || !socket?.connected || chatSending) return;
    setChatSending(true);
    socket.emit('chat-message', { projectId, content });
    setChatInput('');
    // Optimistically add own message (will be replaced by server echo)
    const optimistic: ChatMessage = {
      id: `opt-${Date.now()}`,
      projectId,
      userId,
      username,
      content,
      timestamp: new Date().toISOString()
    };
    setChatMessages(prev => [...prev, optimistic]);
    setTimeout(() => setChatSending(false), 300);
  };

  // ── DEBUGGER TAB ──────────────────────────────────────────────────────────
  const [watchExpressions, setWatchExpressions] = useState<WatchExpression[]>([
    { id: 'w1', expression: 'userId', value: userId, addedBy: username },
    { id: 'w2', expression: 'projectId', value: projectId, addedBy: username }
  ]);
  const [newWatchExpr, setNewWatchExpr] = useState('');

  const handleAddWatch = () => {
    const expr = newWatchExpr.trim();
    if (!expr) return;
    setWatchExpressions(prev => [
      ...prev,
      { id: `w-${Date.now()}`, expression: expr, value: '<not evaluated>', addedBy: username }
    ]);
    setNewWatchExpr('');

    // Broadcast to peers (best-effort)
    if (socket?.connected) {
      socket.emit('watch-sync', { projectId, expression: expr, addedBy: username });
    }
  };

  const handleRemoveWatch = (id: string) => {
    setWatchExpressions(prev => prev.filter(w => w.id !== id));
  };

  // Sync watch expressions from peers
  useEffect(() => {
    if (!socket) return;
    const handler = (data: { expression: string; addedBy: string }) => {
      setWatchExpressions(prev => {
        if (prev.some(w => w.expression === data.expression)) return prev;
        return [
          ...prev,
          { id: `w-${Date.now()}`, expression: data.expression, value: '<synced>', addedBy: data.addedBy }
        ];
      });
    };
    socket.on('watch-sync', handler);
    return () => { socket.off('watch-sync', handler); };
  }, [socket]);

  const breakpointList = Array.from(breakpoints.values()).sort(
    (a, b) => a.lineNumber - b.lineNumber
  );

  // ── SIEM TAB ──────────────────────────────────────────────────────────────
  const [securityLogs, setSecurityLogs] = useState<SecurityEvent[]>([]);
  const [siemLoading, setSiemLoading] = useState(false);
  const [siemFilter, setSiemFilter] = useState<string>('ALL');
  const [attackRunning, setAttackRunning] = useState<RedTeamAttackType | null>(null);
  const [lastAttack, setLastAttack] = useState<AttackResult | null>(null);
  const siemEndRef = useRef<HTMLDivElement>(null);

  const loadSecurityLogs = useCallback(async () => {
    setSiemLoading(true);
    try {
      const logs = await fetchSecurityLogs(projectId, 50);
      setSecurityLogs(logs);
    } catch {
      /* silent */
    } finally {
      setSiemLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (isOpen && activeTab === 'siem') {
      loadSecurityLogs();
    }
  }, [isOpen, activeTab, loadSecurityLogs]);

  // Live SIEM feed via Socket.IO
  useEffect(() => {
    if (!socket) return;
    const handler = (data: {
      type: string;
      message: string;
      severity?: string;
      details?: string;
      userId?: string;
      username?: string;
      timestamp: string;
    }) => {
      const syntheticEvent: SecurityEvent = {
        id: `live-${Date.now()}`,
        project_id: projectId,
        user_id: data.userId ?? null,
        username: data.username ?? null,
        event_type: data.type,
        severity: (data.severity as SecurityEvent['severity']) ?? 'HIGH',
        details: data.details ?? data.message,
        blocked: true,
        created_at: data.timestamp
      };
      setSecurityLogs(prev => [syntheticEvent, ...prev].slice(0, 100));
    };
    socket.on('security-alert', handler);
    return () => { socket.off('security-alert', handler); };
  }, [socket, projectId]);

  const handleRunAttack = async (attackType: RedTeamAttackType) => {
    setAttackRunning(attackType);
    setLastAttack(null);
    try {
      const result = await simulateRedTeamAttack(projectId, attackType);
      setLastAttack(result);
      await loadSecurityLogs();
    } catch (err: any) {
      setLastAttack({
        type: attackType,
        blocked: true,
        status: err.response?.status ?? 403,
        message: 'Attack blocked by zero-trust gateway',
        details: err.message ?? '',
        timestamp: new Date().toISOString()
      });
    } finally {
      setAttackRunning(null);
    }
  };

  const ATTACK_TYPES: { type: RedTeamAttackType; label: string; icon: React.ElementType; color: string }[] = [
    { type: 'rce', label: 'RCE Inject', icon: Flame, color: 'rose' },
    { type: 'traversal', label: 'Dir Traversal', icon: SearchCode, color: 'amber' },
    { type: 'rbac', label: 'RBAC Bypass', icon: Lock, color: 'indigo' },
    { type: 'flood', label: 'Rate Flood', icon: Zap, color: 'cyan' }
  ];

  const EVENT_TYPES = ['ALL', 'SANDBOX_ESCAPE_BLOCKED', 'PATH_TRAVERSAL_BLOCKED', 'RBAC_VIOLATION_ATTEMPT', 'WS_FLOOD_THROTTLED', 'RATE_LIMIT_EXCEEDED'];
  const filteredLogs = securityLogs.filter(
    e => siemFilter === 'ALL' || e.event_type === siemFilter
  );

  // ── AI CO-PILOT TAB ───────────────────────────────────────────────────────
  const [aiResult, setAiResult] = useState<AIAssistResponse | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiActiveMode, setAiActiveMode] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const AI_ACTIONS: { id: string; label: string; icon: React.ElementType; prompt: string; color: string }[] = [
    {
      id: 'explain',
      label: 'Explain Code',
      icon: BookOpen,
      prompt: 'Explain what this code does in clear, plain English. Describe its purpose, logic flow, and key data structures.',
      color: 'indigo'
    },
    {
      id: 'audit',
      label: 'Audit Security Vulnerabilities',
      icon: ShieldAlert,
      prompt: 'Perform a comprehensive security audit. Identify all vulnerabilities including: injection attacks, prototype pollution, path traversal, RCE vectors, RBAC bypasses, and insecure patterns.',
      color: 'rose'
    },
    {
      id: 'debug',
      label: 'Debug Errors',
      icon: Wrench,
      prompt: 'Analyze this code for bugs, runtime errors, logical mistakes, and edge cases. Provide corrected code with explanations.',
      color: 'amber'
    },
    {
      id: 'tests',
      label: 'Generate Unit Tests',
      icon: TestTube2,
      prompt: 'Generate comprehensive unit tests for this code. Cover happy paths, edge cases, error states, and security boundaries. Use Jest/Vitest compatible syntax.',
      color: 'emerald'
    }
  ];

  const handleAiAction = async (action: typeof AI_ACTIONS[0]) => {
    setAiActiveMode(action.id);
    setAiLoading(true);
    setAiError(null);
    setAiResult(null);
    try {
      const codeToSend = (liveCode || currentFile?.content || '').trim();
      const result = await requestAIAssist(action.prompt, codeToSend, language);
      setAiResult(result);
    } catch (err: any) {
      setAiError(err.message ?? 'AI Co-Pilot unavailable.');
    } finally {
      setAiLoading(false);
    }
  };

  const activeAiCode = (liveCode || currentFile?.content || '').trim();

  if (!isOpen) return null;

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full w-80 flex-shrink-0 flex-col border-l border-[#1E293B] bg-[#090D16] text-[#CBD7EE]">

      {/* ─── Drawer Header ──────────────────────────────────────────────── */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-[#1E293B] bg-[#0D1424] px-3 py-2">
        <span className="text-xs font-semibold text-slate-300">Collaboration Panel</span>
        <button
          onClick={onClose}
          className="rounded p-1 text-slate-500 hover:bg-[#1E293B] hover:text-slate-200 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* ─── Tab Bar ────────────────────────────────────────────────────── */}
      <div className="flex flex-shrink-0 border-b border-[#1E293B] bg-[#080C14] p-1 space-x-0.5">
        <TabButton tab="comments" active={activeTab} label="Comments" icon={MessageSquare} badge={unresolvedCount} onClick={setActiveTab} />
        <TabButton tab="chat" active={activeTab} label="Chat" icon={MessagesSquare} onClick={setActiveTab} />
        <TabButton tab="debugger" active={activeTab} label="Debugger" icon={Bug} badge={breakpointList.length} onClick={setActiveTab} />
        <TabButton tab="siem" active={activeTab} label="SIEM" icon={Shield} badge={securityLogs.filter(l => l.blocked).length || undefined} onClick={setActiveTab} />
        <TabButton tab="ai" active={activeTab} label="AI" icon={Sparkles} onClick={setActiveTab} />
      </div>

      {/* ─── Tab Content ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">

        {/* ══════════════ COMMENTS TAB ══════════════ */}
        {activeTab === 'comments' && (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Add comment form */}
            <div className="flex-shrink-0 border-b border-[#1E293B] bg-[#0A0F1D] p-3 space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {currentFile ? `File: ${currentFile.name}` : 'No file selected'}
              </div>

              <div className="flex space-x-1.5">
                <input
                  type="number"
                  min={1}
                  value={newCommentLine}
                  onChange={e => setNewCommentLine(e.target.value ? Number(e.target.value) : '')}
                  placeholder="Line"
                  disabled={!canWrite || !currentFile}
                  className="w-16 flex-shrink-0 rounded border border-[#253554] bg-[#080C14] px-2 py-1.5 text-xs text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500/60 disabled:opacity-50"
                />
                <input
                  type="text"
                  value={newCommentText}
                  onChange={e => setNewCommentText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey && canWrite) {
                      e.preventDefault();
                      handleAddComment();
                    }
                  }}
                  placeholder={canWrite ? 'Add code review comment...' : 'VIEWER: read-only'}
                  disabled={!canWrite || !currentFile || commentSubmitting}
                  className="flex-1 min-w-0 rounded border border-[#253554] bg-[#080C14] px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500/60 disabled:opacity-50"
                />
                <button
                  onClick={handleAddComment}
                  disabled={!canWrite || !currentFile || commentSubmitting || !newCommentText.trim() || !newCommentLine}
                  className="flex-shrink-0 rounded border border-indigo-500/50 bg-indigo-600/25 px-2 py-1.5 text-xs text-indigo-300 hover:bg-indigo-600/40 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
                >
                  {commentSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                </button>
              </div>

              {commentError && (
                <p className="text-[11px] text-rose-400">{commentError}</p>
              )}

              <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-500">
                  {unresolvedCount} open thread{unresolvedCount !== 1 ? 's' : ''}
                </span>
                <button
                  onClick={() => setShowResolved(!showResolved)}
                  className="flex items-center space-x-1 text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
                >
                  {showResolved ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  <span>{showResolved ? 'Hide resolved' : 'Show resolved'}</span>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {commentsLoading ? (
                <div className="flex items-center justify-center py-8 text-slate-500 space-x-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-xs">Loading comments...</span>
                </div>
              ) : sortedLines.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 space-y-2 text-slate-600 px-4 text-center">
                  <MessageSquare className="h-7 w-7 opacity-40" />
                  <p className="text-xs">No {showResolved ? '' : 'open '}threads.</p>
                  <p className="text-[11px]">Add a line number and comment above.</p>
                </div>
              ) : (
                <div className="divide-y divide-[#1A2236]">
                  {sortedLines.map(line => (
                    <div key={line} className="p-3 space-y-2">
                      <button
                        onClick={() => onJumpToLine?.(line)}
                        className="flex items-center space-x-1.5 text-[11px] font-mono font-bold text-indigo-400 hover:text-indigo-300 transition-colors group"
                      >
                        <Hash className="h-3.5 w-3.5" />
                        <span>Line {line}</span>
                        <ChevronRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </button>

                      {commentsByLine[line].map(comment => (
                        <div
                          key={comment.id}
                          className={cn(
                            'rounded border bg-[#080C14] p-2.5 space-y-1.5 text-xs',
                            comment.is_resolved
                              ? 'border-emerald-900/40 opacity-60'
                              : 'border-[#1E293B]'
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-1.5">
                              <User className="h-3 w-3 text-slate-500" />
                              <span className="font-semibold text-slate-300 text-[11px]">
                                {comment.author_name}
                              </span>
                              {comment.is_resolved && (
                                <span className="text-[10px] text-emerald-500 font-medium">✓ Resolved</span>
                              )}
                            </div>
                            <div className="flex items-center space-x-1.5">
                              <span className="text-[10px] text-slate-600">
                                {formatRelative(comment.created_at)}
                              </span>
                              {canWrite && (
                                <button
                                  onClick={() => handleResolveComment(comment.id, !comment.is_resolved)}
                                  disabled={resolving === comment.id}
                                  className={cn(
                                    'text-[10px] font-medium transition-colors',
                                    comment.is_resolved
                                      ? 'text-slate-500 hover:text-slate-300'
                                      : 'text-emerald-500 hover:text-emerald-400'
                                  )}
                                >
                                  {resolving === comment.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : comment.is_resolved ? (
                                    'Reopen'
                                  ) : (
                                    'Resolve'
                                  )}
                                </button>
                              )}
                            </div>
                          </div>
                          <p className="text-[11px] text-slate-300 leading-relaxed whitespace-pre-wrap">
                            {comment.content}
                          </p>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══════════════ CHAT TAB ══════════════ */}
        {activeTab === 'chat' && (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Messages */}
            <div className="flex-1 overflow-y-auto space-y-3 p-3">
              {chatMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full space-y-2 text-slate-600">
                  <MessagesSquare className="h-8 w-8 opacity-40" />
                  <p className="text-xs text-center">No messages yet. Start the conversation.</p>
                </div>
              ) : (
                chatMessages.map((msg, idx) => {
                  const isOwn = msg.userId === userId;
                  const prev = chatMessages[idx - 1];
                  const showMeta = !prev || prev.userId !== msg.userId;

                  return (
                    <div key={msg.id} className={cn('flex flex-col', isOwn ? 'items-end' : 'items-start')}>
                      {showMeta && (
                        <div className={cn(
                          'flex items-center space-x-1.5 mb-1',
                          isOwn ? 'flex-row-reverse space-x-reverse' : ''
                        )}>
                          <span className="text-[11px] font-semibold text-slate-300">
                            {isOwn ? 'You' : msg.username}
                          </span>
                          <span className="text-[10px] text-slate-600">
                            {formatTime(msg.timestamp)}
                          </span>
                        </div>
                      )}
                      <div
                        className={cn(
                          'max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed',
                          isOwn
                            ? 'bg-indigo-600/40 border border-indigo-500/40 text-slate-100 rounded-tr-none'
                            : 'bg-[#0F172A] border border-[#1E293B] text-slate-200 rounded-tl-none'
                        )}
                      >
                        {msg.content}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div className="flex-shrink-0 border-t border-[#1E293B] bg-[#0A0F1D] p-3">
              <div className="flex space-x-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSendChat();
                    }
                  }}
                  placeholder={socket?.connected ? `Message as ${username}…` : 'Disconnected…'}
                  disabled={!socket?.connected || chatSending}
                  maxLength={1000}
                  className="flex-1 min-w-0 rounded border border-[#253554] bg-[#080C14] px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500/60 disabled:opacity-50"
                />
                <button
                  onClick={handleSendChat}
                  disabled={!chatInput.trim() || !socket?.connected || chatSending}
                  className="flex-shrink-0 rounded border border-indigo-500/50 bg-indigo-600/25 px-2.5 py-1.5 text-indigo-300 hover:bg-indigo-600/40 disabled:opacity-40 transition-colors"
                >
                  {chatSending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
              <p className="mt-1.5 text-[10px] text-slate-600">
                {socket?.connected
                  ? `Connected · ${userRole}`
                  : '⚠ Disconnected from real-time server'}
              </p>
            </div>
          </div>
        )}

        {/* ══════════════ DEBUGGER TAB ══════════════ */}
        {activeTab === 'debugger' && (
          <div className="flex-1 overflow-y-auto p-3 space-y-5">
            {/* Shared Breakpoints */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  <Crosshair className="h-3.5 w-3.5 text-rose-400" />
                  <span>Shared Breakpoints</span>
                </div>
                <span className="text-[10px] text-slate-500">
                  {breakpointList.length} active
                </span>
              </div>

              {breakpointList.length === 0 ? (
                <div className="rounded border border-[#1E293B] bg-[#080C14] px-3 py-4 text-center text-[11px] text-slate-600">
                  <Crosshair className="h-5 w-5 opacity-30 mx-auto mb-1.5" />
                  Click the gutter margin in the editor to set a shared breakpoint.
                </div>
              ) : (
                <ul className="space-y-1">
                  {breakpointList.map(bp => (
                    <li
                      key={bp.id}
                      className="flex items-center justify-between rounded border border-[#1E293B] bg-[#080C14] px-3 py-2"
                    >
                      <div className="flex items-center space-x-2 min-w-0">
                        <span
                          className={cn(
                            'h-2.5 w-2.5 flex-shrink-0 rounded-full',
                            bp.enabled ? 'bg-rose-500' : 'bg-slate-600'
                          )}
                        />
                        <div className="min-w-0">
                          <button
                            onClick={() => onJumpToLine?.(bp.lineNumber)}
                            className="flex items-center space-x-1 font-mono text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
                          >
                            <span>Line {bp.lineNumber}</span>
                            <ChevronRight className="h-3 w-3" />
                          </button>
                          <div className="text-[10px] text-slate-600 truncate">
                            by {bp.username} · {bp.enabled ? 'active' : 'disabled'}
                          </div>
                        </div>
                      </div>
                      <Code2 className="h-3.5 w-3.5 text-slate-700 flex-shrink-0" />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Watch Expressions */}
            <section className="space-y-2">
              <div className="flex items-center space-x-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                <Eye className="h-3.5 w-3.5 text-cyan-400" />
                <span>Variable Watch</span>
              </div>

              <div className="flex space-x-1.5">
                <input
                  type="text"
                  value={newWatchExpr}
                  onChange={e => setNewWatchExpr(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleAddWatch();
                  }}
                  placeholder="Add expression (e.g. arr.length)"
                  className="flex-1 min-w-0 rounded border border-[#253554] bg-[#080C14] px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-600 outline-none focus:border-cyan-500/60"
                />
                <button
                  onClick={handleAddWatch}
                  disabled={!newWatchExpr.trim()}
                  className="flex-shrink-0 rounded border border-cyan-700/50 bg-cyan-950/30 px-2.5 py-1.5 text-cyan-400 hover:bg-cyan-900/40 disabled:opacity-40 transition-colors"
                >
                  <PlusCircle className="h-3.5 w-3.5" />
                </button>
              </div>

              {watchExpressions.length === 0 ? (
                <div className="rounded border border-[#1E293B] bg-[#080C14] px-3 py-4 text-center text-[11px] text-slate-600">
                  No watch expressions. Add one above to track shared variables.
                </div>
              ) : (
                <ul className="space-y-1">
                  {watchExpressions.map(w => (
                    <li
                      key={w.id}
                      className="flex items-start justify-between rounded border border-[#1E293B] bg-[#080C14] px-2.5 py-2 space-x-2"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-[11px] text-cyan-300 truncate">{w.expression}</div>
                        <div className="font-mono text-[11px] text-slate-400 truncate">{w.value}</div>
                        <div className="text-[10px] text-slate-600">added by {w.addedBy}</div>
                      </div>
                      <button
                        onClick={() => handleRemoveWatch(w.id)}
                        className="flex-shrink-0 text-slate-700 hover:text-rose-400 transition-colors mt-0.5"
                      >
                        <MinusCircle className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        {/* ══════════════ SIEM TAB ══════════════ */}
        {activeTab === 'siem' && (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Red-Team Buttons */}
            <div className="flex-shrink-0 border-b border-[#1E293B] bg-[#0A0F1D] p-3 space-y-2.5">
              <div className="flex items-center space-x-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500">
                <Flame className="h-3.5 w-3.5" />
                <span>Red-Team Attack Simulator</span>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                {ATTACK_TYPES.map(atk => {
                  const Icon = atk.icon;
                  const isRunning = attackRunning === atk.type;
                  return (
                    <button
                      key={atk.type}
                      onClick={() => handleRunAttack(atk.type)}
                      disabled={attackRunning !== null}
                      className={cn(
                        'flex items-center space-x-1.5 rounded border px-2.5 py-2 text-[11px] font-medium transition-all disabled:opacity-50',
                        atk.color === 'rose' && 'border-rose-800/60 bg-rose-950/30 text-rose-300 hover:bg-rose-900/40',
                        atk.color === 'amber' && 'border-amber-800/60 bg-amber-950/30 text-amber-300 hover:bg-amber-900/40',
                        atk.color === 'indigo' && 'border-indigo-800/60 bg-indigo-950/30 text-indigo-300 hover:bg-indigo-900/40',
                        atk.color === 'cyan' && 'border-cyan-800/60 bg-cyan-950/30 text-cyan-300 hover:bg-cyan-900/40'
                      )}
                    >
                      {isRunning ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Icon className="h-3.5 w-3.5" />
                      )}
                      <span>{isRunning ? 'Testing...' : atk.label}</span>
                    </button>
                  );
                })}
              </div>

              {lastAttack && (
                <div
                  className={cn(
                    'rounded border px-2.5 py-2 text-[11px] space-y-0.5',
                    lastAttack.blocked
                      ? 'border-emerald-700/50 bg-emerald-950/20 text-emerald-300'
                      : 'border-rose-700/50 bg-rose-950/20 text-rose-300'
                  )}
                >
                  <div className="flex items-center space-x-1.5 font-semibold">
                    {lastAttack.blocked ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 text-rose-400" />
                    )}
                    <span>{lastAttack.message}</span>
                  </div>
                  <div className="text-[10px] text-slate-400">{lastAttack.details}</div>
                </div>
              )}

              {/* Filter */}
              <div className="flex items-center space-x-1.5">
                <span className="text-[10px] text-slate-600 flex-shrink-0">Filter:</span>
                <select
                  value={siemFilter}
                  onChange={e => setSiemFilter(e.target.value)}
                  className="flex-1 min-w-0 rounded border border-[#253554] bg-[#080C14] px-2 py-1 text-[11px] text-slate-300 outline-none"
                >
                  {EVENT_TYPES.map(t => (
                    <option key={t} value={t}>{t === 'ALL' ? 'All Events' : t}</option>
                  ))}
                </select>
                <button
                  onClick={loadSecurityLogs}
                  disabled={siemLoading}
                  className="flex-shrink-0 rounded border border-[#253554] bg-[#080C14] p-1 text-slate-500 hover:text-slate-300 disabled:opacity-40 transition-colors"
                >
                  {siemLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Activity className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>

            {/* Event Log Feed */}
            <div className="flex-1 overflow-y-auto">
              {filteredLogs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full space-y-2 text-slate-600 py-10">
                  <Shield className="h-8 w-8 opacity-30" />
                  <p className="text-xs">No security events yet.</p>
                  <p className="text-[11px] text-center px-4">Run a Red-Team test above to validate zero-trust defenses.</p>
                </div>
              ) : (
                <ul className="divide-y divide-[#1A2236]">
                  {filteredLogs.map(event => {
                    const EventIcon = getEventIcon(event.event_type);
                    return (
                      <li
                        key={event.id}
                        className={cn(
                          'px-3 py-2.5 space-y-1',
                          getSeverityClass(event.severity)
                        )}
                      >
                        <div className="flex items-start justify-between space-x-2">
                          <div className="flex items-start space-x-1.5 flex-1 min-w-0">
                            <EventIcon className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
                            <div className="min-w-0">
                              <div className="text-[11px] font-mono font-semibold truncate">
                                {event.event_type}
                              </div>
                              <div className="text-[10px] opacity-80 leading-relaxed line-clamp-2">
                                {event.details}
                              </div>
                            </div>
                          </div>
                          <div className="flex flex-col items-end flex-shrink-0 space-y-0.5">
                            <span className={cn(
                              'rounded px-1.5 py-0.5 text-[9px] font-bold uppercase border',
                              event.severity === 'CRITICAL' && 'border-rose-600/60 bg-rose-950 text-rose-300',
                              event.severity === 'HIGH' && 'border-orange-600/60 bg-orange-950 text-orange-300',
                              event.severity === 'MEDIUM' && 'border-amber-600/60 bg-amber-950 text-amber-300',
                              event.severity === 'LOW' && 'border-slate-600/60 bg-slate-950 text-slate-400'
                            )}>
                              {event.severity}
                            </span>
                            {event.blocked && (
                              <span className="text-[9px] text-emerald-500 font-semibold">BLOCKED</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center space-x-2 text-[10px] opacity-60">
                          {event.username && (
                            <span className="flex items-center space-x-1">
                              <User className="h-2.5 w-2.5" />
                              <span>{event.username}</span>
                            </span>
                          )}
                          <span className="flex items-center space-x-1">
                            <Clock className="h-2.5 w-2.5" />
                            <span>{formatRelative(event.created_at)}</span>
                          </span>
                        </div>
                      </li>
                    );
                  })}
                  <div ref={siemEndRef} />
                </ul>
              )}
            </div>
          </div>
        )}

        {/* ══════════════ AI CO-PILOT TAB ══════════════ */}
        {activeTab === 'ai' && (
          <div className="flex-1 overflow-y-auto p-3 space-y-4">
            {/* Header */}
            <div className="rounded-lg border border-indigo-900/50 bg-[#0E1527] p-3 space-y-1">
              <div className="flex items-center space-x-2">
                <div className="rounded-md bg-indigo-600/20 p-1.5 border border-indigo-500/30">
                  <Sparkles className="h-4 w-4 text-indigo-400" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-200">DevCollab AI Co-Pilot</div>
                  <div className="text-[10px] text-slate-500">
                    {currentFile ? `Active: ${currentFile.name}` : 'No file active'}
                  </div>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Actions
              </div>
              <div className="space-y-1.5">
                {AI_ACTIONS.map(action => {
                  const Icon = action.icon;
                  const isActive = aiActiveMode === action.id && aiLoading;
                  return (
                    <button
                      key={action.id}
                      onClick={() => handleAiAction(action)}
                      disabled={aiLoading || !activeAiCode}
                      className={cn(
                        'w-full flex items-center space-x-3 rounded border px-3 py-2.5 text-left text-xs font-medium transition-all disabled:opacity-50',
                        action.color === 'indigo' && 'border-indigo-800/60 bg-indigo-950/30 text-indigo-200 hover:bg-indigo-900/40',
                        action.color === 'rose' && 'border-rose-800/60 bg-rose-950/30 text-rose-200 hover:bg-rose-900/40',
                        action.color === 'amber' && 'border-amber-800/60 bg-amber-950/30 text-amber-200 hover:bg-amber-900/40',
                        action.color === 'emerald' && 'border-emerald-800/60 bg-emerald-950/30 text-emerald-200 hover:bg-emerald-900/40'
                      )}
                    >
                      {isActive ? (
                        <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
                      ) : (
                        <Icon className="h-4 w-4 flex-shrink-0" />
                      )}
                      <span>{isActive ? `Running ${action.label}…` : action.label}</span>
                    </button>
                  );
                })}
              </div>
              {!activeAiCode && (
                <p className="text-[11px] text-slate-600 text-center pt-1">
                  Open a file with code to enable AI Co-Pilot.
                </p>
              )}
            </div>

            {/* AI Error */}
            {aiError && (
              <div className="rounded border border-rose-700/50 bg-rose-950/20 px-3 py-2 text-[11px] text-rose-300 flex items-start space-x-2">
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-px text-rose-400" />
                <span>{aiError}</span>
              </div>
            )}

            {/* AI Result */}
            {aiResult && (
              <div className="space-y-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  AI Response
                </div>

                {/* Explanation */}
                <div className="rounded border border-[#1E293B] bg-[#080C14] p-3 space-y-1.5">
                  <div className="flex items-center space-x-1.5 text-[11px] font-semibold text-slate-300">
                    <BookOpen className="h-3.5 w-3.5 text-indigo-400" />
                    <span>Analysis</span>
                  </div>
                  <p className="text-[11px] text-slate-300 leading-relaxed whitespace-pre-wrap">
                    {aiResult.explanation}
                  </p>
                </div>

                {/* Security Notes */}
                {aiResult.securityNotes && (
                  <div className="rounded border border-emerald-800/40 bg-emerald-950/20 p-3 space-y-1.5">
                    <div className="flex items-center space-x-1.5 text-[11px] font-semibold text-emerald-300">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                      <span>Security Notes</span>
                    </div>
                    <p className="text-[11px] text-emerald-200/80 leading-relaxed whitespace-pre-wrap">
                      {aiResult.securityNotes}
                    </p>
                  </div>
                )}

                {/* Code Suggestion */}
                {aiResult.suggestion && (
                  <div className="rounded border border-[#253554] bg-[#050810] p-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-1.5 text-[11px] font-semibold text-slate-300">
                        <Code2 className="h-3.5 w-3.5 text-cyan-400" />
                        <span>Suggestion</span>
                      </div>
                      <button
                        onClick={() => navigator.clipboard.writeText(aiResult.suggestion)}
                        className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors flex items-center space-x-1"
                      >
                        <Check className="h-3 w-3" />
                        <span>Copy</span>
                      </button>
                    </div>
                    <pre className="text-[11px] text-cyan-200/80 font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed">
                      {aiResult.suggestion}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default CollabDrawer;
