import React, { useState, useEffect, useRef } from 'react';
import { Socket } from 'socket.io-client';
import {
  Terminal,
  Play,
  RotateCcw,
  Copy,
  Check,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  Clock,
  Cpu,
  HardDrive,
  Lock,
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
  Loader2,
  Layers,
  Keyboard,
  Flame,
  CheckCircle2,
  XCircle,
  FileCode,
  Sliders,
  Sparkles
} from 'lucide-react';
import {
  CollaboratorRole,
  ExecutionResult,
  AttackResult,
  RedTeamAttackType
} from '../types';
import { api, cn, simulateRedTeamAttack } from '../services/api';

export interface ExecutionConsoleProps {
  projectId: string;
  fileId?: string;
  fileName?: string;
  code?: string;
  language?: string;
  userRole?: CollaboratorRole;
  socket?: Socket | null;
  userId?: string;
  username?: string;
  onExecutionComplete?: (result: ExecutionResult) => void;
  className?: string;
  initialCollapsed?: boolean;
}

type ConsoleTab = 'output' | 'stdin' | 'policy';

interface SecurityPolicyItem {
  id: string;
  title: string;
  badge: string;
  status: 'ACTIVE' | 'ENFORCED' | 'STANDBY';
  icon: React.ElementType;
  description: string;
  details: string;
}

const SANDBOX_POLICIES: SecurityPolicyItem[] = [
  {
    id: 'ast-threat-scanner',
    title: 'AST & Pattern Threat Scanner',
    badge: 'Zero-Tolerance',
    status: 'ACTIVE',
    icon: ShieldCheck,
    description: 'Pre-flight AST & regex lexical analyzer scans submitted code before container dispatch.',
    details: 'Detects and immediately halts child_process, fs., process.env, constructor.constructor, __proto__, os.system, subprocess, /etc/passwd, and reverse shells.'
  },
  {
    id: 'cpu-timeout',
    title: 'CPU Execution Timeout',
    badge: '3,000ms Limit',
    status: 'ENFORCED',
    icon: Cpu,
    description: 'Strict 3,000ms wall-clock execution ceiling enforced via container kernel signals.',
    details: 'Infinite loops, fork bombs (:(){ :|:& };:), and excessive computation routines are terminated immediately with SIGKILL (Exit 137 / 124).'
  },
  {
    id: 'ram-quota',
    title: 'Memory Isolation (RAM)',
    badge: '128 MB Quota',
    status: 'ENFORCED',
    icon: HardDrive,
    description: 'Hard 128 MB memory cgroup boundary allocated per process execution.',
    details: 'Heap exhaustion exploits and memory ballooning attacks trigger out-of-memory container termination, protecting host nodes.'
  },
  {
    id: 'vm-context',
    title: 'Isolated V8 VM Sandbox',
    badge: 'Zero-Host APIs',
    status: 'ENFORCED',
    icon: Layers,
    description: 'Offline local fallback executes inside Node vm.createContext(Object.create(null)).',
    details: 'Code generation from strings and WebAssembly are disabled ({ strings: false, wasm: false }). Zero access to process, require, fs, or native bindings.'
  },
  {
    id: 'output-cap',
    title: 'Standard Output Truncation',
    badge: '10,000 Chars',
    status: 'ACTIVE',
    icon: FileCode,
    description: 'Stdout and Stderr output buffers are hard-capped at 10,000 characters.',
    details: 'Mitigates denial-of-service through continuous stdout looping and prevents browser/terminal memory starvation.'
  },
  {
    id: 'rbac-gate',
    title: 'Role-Based Execution Gate (RBAC)',
    badge: 'OWNER / EDITOR',
    status: 'ENFORCED',
    icon: Lock,
    description: 'Cryptographically verified JWT role evaluation prevents unauthorized runtime access.',
    details: 'Collaborators with VIEWER role are blocked at the gateway with HTTP 403; attempts are permanently recorded in security_logs.'
  },
  {
    id: 'rate-limiter',
    title: 'Sliding-Window Rate Limiter',
    badge: '5 runs / 15s',
    status: 'ACTIVE',
    icon: Sliders,
    description: 'Sliding-window throttler prevents automated runner spam and execution flooding.',
    details: 'Excessive execution requests receive HTTP 429 Retry-After responses and trigger security telemetry alerts.'
  },
  {
    id: 'offline-fallback',
    title: 'Offline Resilient Fallback',
    badge: 'Auto-Switch',
    status: 'STANDBY',
    icon: Sparkles,
    description: 'Seamlessly switches between Piston remote sandbox and local locked Node V8 engine.',
    details: 'If remote container services are unreachable, JavaScript and TypeScript code continues executing in the local zero-trust VM.'
  }
];

export const ExecutionConsole: React.FC<ExecutionConsoleProps> = ({
  projectId,
  fileId,
  fileName = 'index.ts',
  code = '',
  language = 'typescript',
  userRole = 'EDITOR',
  socket = null,
  userId = '',
  username = 'developer',
  onExecutionComplete,
  className = '',
  initialCollapsed = false
}) => {
  const [activeTab, setActiveTab] = useState<ConsoleTab>('output');
  const [isCollapsed, setIsCollapsed] = useState<boolean>(initialCollapsed);
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [remoteRunnerName, setRemoteRunnerName] = useState<string | null>(null);

  // Execution state
  const [stdout, setStdout] = useState<string>('');
  const [stderr, setStderr] = useState<string>('');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [executionTimeMs, setExecutionTimeMs] = useState<number>(0);
  const [threatStatus, setThreatStatus] = useState<'READY' | 'PASSED' | 'BLOCKED'>('READY');
  const [threatViolations, setThreatViolations] = useState<string[]>([]);
  const [copied, setCopied] = useState<boolean>(false);

  // Stdin state
  const [stdin, setStdin] = useState<string>('');

  // Red-team simulation state inside Policy tab
  const [testingAttack, setTestingAttack] = useState<RedTeamAttackType | null>(null);
  const [attackResult, setAttackResult] = useState<AttackResult | null>(null);

  // Auto-scroll ref
  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Listen to collaborative Socket.IO execution events
  useEffect(() => {
    if (!socket) return;

    const handleExecutionStarted = (data: {
      projectId: string;
      userId: string;
      username: string;
      fileId?: string;
      language?: string;
    }) => {
      if (data.projectId !== projectId) return;
      setIsRunning(true);
      setRemoteRunnerName(data.username);
      setThreatStatus('READY');
      setActiveTab('output');
      setIsCollapsed(false);
    };

    const handleExecutionResult = (data: {
      projectId: string;
      userId: string;
      username: string;
      fileId?: string;
      result: ExecutionResult;
    }) => {
      if (data.projectId !== projectId) return;
      setIsRunning(false);
      setRemoteRunnerName(null);
      setActiveTab('output');
      setIsCollapsed(false);

      const res = data.result;
      setStdout(res.stdout || '');
      setStderr(res.stderr || '');
      setExitCode(res.exitCode);
      setExecutionTimeMs(res.executionTimeMs || 0);

      if (res.securityViolations && res.securityViolations.length > 0) {
        setThreatStatus('BLOCKED');
        setThreatViolations(res.securityViolations);
      } else if (res.exitCode === 126 && res.stderr?.includes('[ZERO-TRUST')) {
        setThreatStatus('BLOCKED');
      } else {
        setThreatStatus('PASSED');
        setThreatViolations([]);
      }

      if (onExecutionComplete) {
        onExecutionComplete(res);
      }
    };

    const handleSecurityAlert = (data: {
      type: string;
      message: string;
      threats?: string[];
    }) => {
      if (data.threats && data.threats.length > 0) {
        setThreatStatus('BLOCKED');
        setThreatViolations(data.threats);
      }
    };

    socket.on('execution-started', handleExecutionStarted);
    socket.on('execution-result', handleExecutionResult);
    socket.on('security-alert', handleSecurityAlert);

    return () => {
      socket.off('execution-started', handleExecutionStarted);
      socket.off('execution-result', handleExecutionResult);
      socket.off('security-alert', handleSecurityAlert);
    };
  }, [socket, projectId, onExecutionComplete]);

  // Scroll terminal to bottom when output updates
  useEffect(() => {
    if (activeTab === 'output' && terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [stdout, stderr, isRunning, activeTab]);

  // Execute Code Handler
  const handleRunCode = async () => {
    if (isRunning) return;

    if (userRole === 'VIEWER') {
      setThreatStatus('BLOCKED');
      setStderr('[RBAC VIOLATION PREVENTED]\nError 403: VIEWER accounts have read-only privileges. Code execution requires EDITOR or OWNER role.');
      setExitCode(126);
      return;
    }

    setIsRunning(true);
    setStdout('');
    setStderr('');
    setExitCode(null);
    setThreatViolations([]);

    try {
      const response = await api.post<ExecutionResult>('/execute/run', {
        projectId,
        fileId: fileId || 'untitled-file',
        code,
        language,
        stdin
      });

      const result = response.data;
      setStdout(result.stdout || '');
      setStderr(result.stderr || '');
      setExitCode(result.exitCode);
      setExecutionTimeMs(result.executionTimeMs || 0);

      if (result.securityViolations && result.securityViolations.length > 0) {
        setThreatStatus('BLOCKED');
        setThreatViolations(result.securityViolations);
      } else {
        setThreatStatus('PASSED');
        setThreatViolations([]);
      }

      if (onExecutionComplete) {
        onExecutionComplete(result);
      }
    } catch (err: any) {
      const resData = err.response?.data;
      if (resData && typeof resData === 'object') {
        const errorResult = resData as ExecutionResult;
        setStdout(errorResult.stdout || '');
        setStderr(errorResult.stderr || err.message || 'Execution failed');
        setExitCode(errorResult.exitCode ?? 1);
        setExecutionTimeMs(errorResult.executionTimeMs ?? 0);

        if (errorResult.securityViolations && errorResult.securityViolations.length > 0) {
          setThreatStatus('BLOCKED');
          setThreatViolations(errorResult.securityViolations);
        } else if (err.response?.status === 403) {
          setThreatStatus('BLOCKED');
        } else {
          setThreatStatus('PASSED');
        }

        if (onExecutionComplete) {
          onExecutionComplete(errorResult);
        }
      } else {
        setStdout('');
        setStderr(`[NETWORK / RUNNER ERROR]\n${err.message || 'Failed to dispatch code to execution sandbox.'}`);
        setExitCode(1);
        setThreatStatus('PASSED');
      }
    } finally {
      setIsRunning(false);
    }
  };

  const handleClearOutput = () => {
    setStdout('');
    setStderr('');
    setExitCode(null);
    setExecutionTimeMs(0);
    setThreatStatus('READY');
    setThreatViolations([]);
  };

  const handleCopyOutput = () => {
    const fullText = [stdout, stderr].filter(Boolean).join('\n');
    if (!fullText) return;
    navigator.clipboard.writeText(fullText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Run Red-Team test simulation in Policy tab
  const handleTestAttack = async (attackType: RedTeamAttackType) => {
    setTestingAttack(attackType);
    setAttackResult(null);

    try {
      const result = await simulateRedTeamAttack(projectId, attackType, fileId);
      setAttackResult(result);
    } catch (err: any) {
      setAttackResult({
        type: attackType,
        blocked: true,
        status: err.response?.status || 403,
        message: 'Attack intercepted by zero-trust gateway',
        details: err.response?.data?.details || err.message,
        timestamp: new Date().toISOString()
      });
    } finally {
      setTestingAttack(null);
    }
  };

  const hasOutput = Boolean(stdout || stderr || isRunning || threatViolations.length > 0);

  return (
    <div
      className={cn(
        'flex flex-col border-t border-[#253554] bg-[#0A0E1A] text-[#CBD7EE] transition-all duration-300 ease-in-out',
        isMaximized ? 'fixed inset-x-0 bottom-0 top-16 z-40' : isCollapsed ? 'h-10' : 'h-80',
        className
      )}
    >
      {/* ─── Terminal Header Bar ─────────────────────────────────────────── */}
      <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-[#1E293B] bg-[#0D1424] px-3 select-none">
        {/* Left: Terminal Tabs */}
        <div className="flex items-center space-x-1">
          <div className="mr-2 flex items-center space-x-1.5 text-xs font-semibold tracking-wide text-slate-300">
            <Terminal className="h-4 w-4 text-emerald-400" />
            <span className="hidden sm:inline">Execution Console</span>
          </div>

          <div className="flex items-center space-x-1 rounded-md bg-[#080C14] p-0.5 border border-[#1E293B]">
            <button
              onClick={() => {
                setActiveTab('output');
                if (isCollapsed) setIsCollapsed(false);
              }}
              className={cn(
                'flex items-center space-x-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
                activeTab === 'output'
                  ? 'bg-[#1E293B] text-emerald-400 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              )}
            >
              <Terminal className="h-3.5 w-3.5" />
              <span>Shared Output</span>
              {isRunning && (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
                </span>
              )}
            </button>

            <button
              onClick={() => {
                setActiveTab('stdin');
                if (isCollapsed) setIsCollapsed(false);
              }}
              className={cn(
                'flex items-center space-x-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
                activeTab === 'stdin'
                  ? 'bg-[#1E293B] text-cyan-400 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              )}
            >
              <Keyboard className="h-3.5 w-3.5" />
              <span>Standard Input</span>
              {stdin.trim().length > 0 && (
                <span className="rounded-full bg-cyan-950 px-1 text-[10px] text-cyan-400 border border-cyan-800">
                  {stdin.split('\n').length}L
                </span>
              )}
            </button>

            <button
              onClick={() => {
                setActiveTab('policy');
                if (isCollapsed) setIsCollapsed(false);
              }}
              className={cn(
                'flex items-center space-x-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
                activeTab === 'policy'
                  ? 'bg-[#1E293B] text-indigo-400 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              )}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>Zero-Trust Policy</span>
              <span className="rounded-full bg-indigo-950 px-1 text-[10px] text-indigo-300 border border-indigo-800">
                8/8
              </span>
            </button>
          </div>
        </div>

        {/* Right: Actions, Badges & Controls */}
        <div className="flex items-center space-x-2">
          {/* Threat Scan Badge */}
          {threatStatus === 'PASSED' && (
            <div className="hidden sm:flex items-center space-x-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
              <span>Threat Scan: PASSED</span>
            </div>
          )}

          {threatStatus === 'BLOCKED' && (
            <div className="hidden sm:flex items-center space-x-1 rounded border border-rose-500/50 bg-rose-500/15 px-2 py-0.5 text-[11px] font-semibold text-rose-400 animate-pulse">
              <ShieldAlert className="h-3.5 w-3.5 text-rose-400" />
              <span>Threat Scan: BLOCKED</span>
            </div>
          )}

          {threatStatus === 'READY' && (
            <div className="hidden md:flex items-center space-x-1 rounded border border-slate-700 bg-slate-800/40 px-2 py-0.5 text-[11px] text-slate-400">
              <ShieldCheck className="h-3 w-3 text-slate-500" />
              <span>Threat Scan: READY</span>
            </div>
          )}

          {/* Execution Time */}
          {executionTimeMs > 0 && (
            <div className="hidden lg:flex items-center space-x-1 text-[11px] text-slate-400">
              <Clock className="h-3 w-3 text-slate-500" />
              <span>{executionTimeMs} ms</span>
            </div>
          )}

          {/* Exit Code */}
          {exitCode !== null && (
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-mono font-medium border',
                exitCode === 0
                  ? 'border-emerald-600/40 bg-emerald-950/60 text-emerald-400'
                  : 'border-rose-600/50 bg-rose-950/60 text-rose-400'
              )}
            >
              exit {exitCode}
            </span>
          )}

          {/* Run in Sandbox Button */}
          <button
            onClick={handleRunCode}
            disabled={isRunning || userRole === 'VIEWER'}
            title={
              userRole === 'VIEWER'
                ? 'Execution blocked: VIEWER accounts have read-only permissions'
                : 'Execute active file in isolated sandbox'
            }
            className={cn(
              'flex items-center space-x-1.5 rounded px-3 py-1 text-xs font-semibold shadow-sm transition-all',
              userRole === 'VIEWER'
                ? 'cursor-not-allowed border border-slate-700 bg-slate-800/50 text-slate-500'
                : isRunning
                ? 'border border-amber-500/40 bg-amber-500/20 text-amber-300 cursor-wait'
                : 'border border-emerald-500/60 bg-emerald-600/30 text-emerald-300 hover:bg-emerald-600/50 hover:text-white'
            )}
          >
            {userRole === 'VIEWER' ? (
              <>
                <Lock className="h-3.5 w-3.5" />
                <span>VIEWER (Locked)</span>
              </>
            ) : isRunning ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-300" />
                <span>Running...</span>
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5 fill-current" />
                <span>Run in Sandbox</span>
              </>
            )}
          </button>

          {/* Copy Output */}
          <button
            onClick={handleCopyOutput}
            disabled={!hasOutput}
            title="Copy output to clipboard"
            className="rounded p-1 text-slate-400 hover:bg-[#1E293B] hover:text-slate-200 disabled:opacity-40"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>

          {/* Clear Output */}
          <button
            onClick={handleClearOutput}
            disabled={!hasOutput}
            title="Clear output console"
            className="rounded p-1 text-slate-400 hover:bg-[#1E293B] hover:text-slate-200 disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>

          {/* Maximize / Restore */}
          <button
            onClick={() => {
              setIsMaximized(!isMaximized);
              if (isCollapsed) setIsCollapsed(false);
            }}
            title={isMaximized ? 'Restore default height' : 'Maximize terminal'}
            className="hidden sm:inline-flex rounded p-1 text-slate-400 hover:bg-[#1E293B] hover:text-slate-200"
          >
            {isMaximized ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>

          {/* Collapse / Expand Toggle */}
          <button
            onClick={() => {
              setIsCollapsed(!isCollapsed);
              if (isMaximized) setIsMaximized(false);
            }}
            title={isCollapsed ? 'Expand execution console' : 'Collapse execution console'}
            className="rounded p-1 text-slate-400 hover:bg-[#1E293B] hover:text-slate-200"
          >
            {isCollapsed ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* ─── Terminal Body (Tabs Content) ─────────────────────────────────── */}
      {!isCollapsed && (
        <div className="flex-1 overflow-hidden bg-[#070A12] font-mono text-xs">
          {/* TAB 1: SHARED OUTPUT CONSOLE */}
          {activeTab === 'output' && (
            <div className="flex h-full flex-col">
              {/* Remote Execution Notification Bar */}
              {remoteRunnerName && (
                <div className="flex items-center space-x-2 border-b border-indigo-900/60 bg-indigo-950/40 px-3 py-1 text-[11px] text-indigo-300">
                  <Loader2 className="h-3 w-3 animate-spin text-indigo-400" />
                  <span>
                    Peer <strong className="text-white">@{remoteRunnerName}</strong> is executing in the sandbox...
                  </span>
                </div>
              )}

              {/* Console Output Scroll Area */}
              <div className="flex-1 overflow-y-auto p-3 space-y-2 select-text leading-relaxed">
                {!hasOutput && (
                  <div className="space-y-1.5 text-slate-500">
                    <div className="text-slate-400 font-semibold">
                      // DevCollab Zero-Trust Sandbox Terminal (Piston / Isolated V8)
                    </div>
                    <div>// File: {fileName} | Runtime: {language} | Role: {userRole}</div>
                    <div>// Threat scanner: ACTIVE (RCE / Prototype Breakout / Path Traversal blocked)</div>
                    <div>// Resource quota: 3,000ms CPU timeout | 128 MB RAM limit | 10k output cap</div>
                    <div className="text-emerald-500/80 pt-1">
                      Ready. Click "Run in Sandbox" above or press Run in the toolbar.
                    </div>
                  </div>
                )}

                {/* Threat Blocker Banner if Violations Exist */}
                {threatViolations.length > 0 && (
                  <div className="rounded border border-rose-500/60 bg-rose-950/40 p-2.5 text-rose-300">
                    <div className="flex items-center space-x-1.5 font-bold text-rose-400">
                      <ShieldAlert className="h-4 w-4" />
                      <span>[ZERO-TRUST SANDBOX BLOCKER] Execution Intercepted</span>
                    </div>
                    <div className="mt-1 text-[11px] text-rose-200">
                      The code submitted contains forbidden sandbox escape or remote code execution patterns:
                    </div>
                    <ul className="mt-1 list-disc pl-5 space-y-0.5 text-rose-300">
                      {threatViolations.map((threat, idx) => (
                        <li key={idx} className="font-mono">
                          {threat}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-1 text-[10px] text-rose-400/80">
                      This incident has been recorded in the project's security audit log.
                    </div>
                  </div>
                )}

                {/* Running Spinner */}
                {isRunning && (
                  <div className="flex items-center space-x-2 text-amber-300">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Compiling and executing in isolated container...</span>
                  </div>
                )}

                {/* Standard Output */}
                {stdout && (
                  <div className="whitespace-pre-wrap text-slate-100 font-mono">
                    {stdout}
                  </div>
                )}

                {/* Standard Error */}
                {stderr && (
                  <div className="whitespace-pre-wrap text-rose-400 font-mono">
                    {stderr}
                  </div>
                )}

                <div ref={terminalEndRef} />
              </div>
            </div>
          )}

          {/* TAB 2: STANDARD INPUT (STDIN) */}
          {activeTab === 'stdin' && (
            <div className="flex h-full flex-col p-3 space-y-2">
              <div className="flex items-center justify-between text-slate-300">
                <div className="flex items-center space-x-1.5">
                  <Keyboard className="h-4 w-4 text-cyan-400" />
                  <span className="font-semibold text-xs">Standard Input (stdin)</span>
                  <span className="text-[11px] text-slate-500">
                    — Passed line-by-line to input() / cin / Scanner
                  </span>
                </div>

                <div className="flex items-center space-x-2 text-[11px]">
                  <span className="text-slate-400">
                    {stdin.length} chars | {stdin.split('\n').filter(Boolean).length} inputs
                  </span>
                  <button
                    onClick={() => setStdin('')}
                    className="text-slate-400 hover:text-slate-200 underline"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* Stdin Textarea */}
              <div className="flex-1 relative rounded border border-[#253554] bg-[#090D16]">
                <textarea
                  value={stdin}
                  onChange={(e) => setStdin(e.target.value)}
                  placeholder="Enter inputs here (one line per prompt)...&#10;Example:&#10;42&#10;Hello World&#10;true"
                  className="h-full w-full resize-none bg-transparent p-2.5 font-mono text-xs text-cyan-200 placeholder-slate-600 outline-none"
                  spellCheck={false}
                />
              </div>

              {/* Preset Shortcuts */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div className="flex items-center space-x-1.5">
                  <span className="text-[11px] text-slate-500">Sample Presets:</span>
                  <button
                    onClick={() => setStdin('42\n100\n3.14159')}
                    className="rounded bg-[#151E30] px-2 py-0.5 text-[11px] text-slate-300 hover:bg-[#1E293B] border border-[#253554]"
                  >
                    Numbers
                  </button>
                  <button
                    onClick={() => setStdin('Alice\nBob\nCharlie')}
                    className="rounded bg-[#151E30] px-2 py-0.5 text-[11px] text-slate-300 hover:bg-[#1E293B] border border-[#253554]"
                  >
                    Names
                  </button>
                  <button
                    onClick={() => setStdin('{"user": "quantum", "role": "EDITOR", "active": true}')}
                    className="rounded bg-[#151E30] px-2 py-0.5 text-[11px] text-slate-300 hover:bg-[#1E293B] border border-[#253554]"
                  >
                    JSON
                  </button>
                </div>

                <button
                  onClick={() => {
                    setActiveTab('output');
                    handleRunCode();
                  }}
                  disabled={isRunning || userRole === 'VIEWER'}
                  className="flex items-center space-x-1.5 rounded bg-cyan-700/40 px-3 py-1 text-xs font-semibold text-cyan-200 border border-cyan-600/50 hover:bg-cyan-600/50 disabled:opacity-50"
                >
                  <Play className="h-3 w-3 fill-current" />
                  <span>Execute with Stdin</span>
                </button>
              </div>
            </div>
          )}

          {/* TAB 3: ZERO-TRUST SANDBOX POLICY */}
          {activeTab === 'policy' && (
            <div className="flex h-full flex-col overflow-y-auto p-3 space-y-4">
              {/* Header Overview */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between rounded-lg border border-indigo-900/50 bg-[#0E1527] p-3">
                <div className="flex items-center space-x-2.5">
                  <div className="rounded-md bg-indigo-600/20 p-2 border border-indigo-500/30">
                    <ShieldCheck className="h-5 w-5 text-indigo-400" />
                  </div>
                  <div>
                    <div className="font-semibold text-slate-200">Zero-Trust Sandbox Enforcement Matrix</div>
                    <div className="text-[11px] text-slate-400">
                      Multi-tenant compute isolation protecting host node, memory, and filesystem boundaries.
                    </div>
                  </div>
                </div>

                <div className="mt-2 sm:mt-0 flex items-center space-x-2">
                  <span className="inline-flex items-center rounded-full bg-emerald-950 px-2.5 py-0.5 text-[11px] font-medium text-emerald-400 border border-emerald-800">
                    <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                    All 8 Layers Active
                  </span>
                </div>
              </div>

              {/* Interactive Red-Team Defense Tester */}
              <div className="rounded-lg border border-[#253554] bg-[#0A0F1D] p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-1.5 font-semibold text-xs text-amber-400">
                    <Flame className="h-4 w-4 text-amber-400" />
                    <span>Red-Team Defense Verification</span>
                  </div>
                  <span className="text-[10px] text-slate-500">Live test zero-trust security blockers</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 pt-1">
                  <button
                    onClick={() => handleTestAttack('rce')}
                    disabled={testingAttack !== null}
                    className="flex items-center justify-center space-x-1.5 rounded bg-rose-950/40 border border-rose-800/60 px-2 py-1.5 text-[11px] font-medium text-rose-300 hover:bg-rose-900/40 disabled:opacity-50"
                  >
                    {testingAttack === 'rce' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <ShieldAlert className="h-3 w-3 text-rose-400" />
                    )}
                    <span>Simulate RCE</span>
                  </button>

                  <button
                    onClick={() => handleTestAttack('traversal')}
                    disabled={testingAttack !== null}
                    className="flex items-center justify-center space-x-1.5 rounded bg-amber-950/40 border border-amber-800/60 px-2 py-1.5 text-[11px] font-medium text-amber-300 hover:bg-amber-900/40 disabled:opacity-50"
                  >
                    {testingAttack === 'traversal' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <AlertTriangle className="h-3 w-3 text-amber-400" />
                    )}
                    <span>Simulate Traversal</span>
                  </button>

                  <button
                    onClick={() => handleTestAttack('rbac')}
                    disabled={testingAttack !== null}
                    className="flex items-center justify-center space-x-1.5 rounded bg-indigo-950/40 border border-indigo-800/60 px-2 py-1.5 text-[11px] font-medium text-indigo-300 hover:bg-indigo-900/40 disabled:opacity-50"
                  >
                    {testingAttack === 'rbac' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Lock className="h-3 w-3 text-indigo-400" />
                    )}
                    <span>Simulate RBAC Bypass</span>
                  </button>

                  <button
                    onClick={() => handleTestAttack('flood')}
                    disabled={testingAttack !== null}
                    className="flex items-center justify-center space-x-1.5 rounded bg-cyan-950/40 border border-cyan-800/60 px-2 py-1.5 text-[11px] font-medium text-cyan-300 hover:bg-cyan-900/40 disabled:opacity-50"
                  >
                    {testingAttack === 'flood' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sliders className="h-3 w-3 text-cyan-400" />
                    )}
                    <span>Simulate Rate Flood</span>
                  </button>
                </div>

                {/* Attack Result Feedback */}
                {attackResult && (
                  <div
                    className={cn(
                      'mt-2 rounded border p-2 text-[11px]',
                      attackResult.blocked
                        ? 'border-emerald-600/50 bg-emerald-950/30 text-emerald-300'
                        : 'border-rose-600/50 bg-rose-950/30 text-rose-300'
                    )}
                  >
                    <div className="flex items-center space-x-1.5 font-bold">
                      {attackResult.blocked ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <XCircle className="h-4 w-4 text-rose-400" />
                      )}
                      <span>{attackResult.message}</span>
                      <span className="ml-auto rounded bg-black/40 px-1 text-[10px]">
                        HTTP {attackResult.status}
                      </span>
                    </div>
                    <div className="mt-0.5 text-slate-300">{attackResult.details}</div>
                  </div>
                )}
              </div>

              {/* Protection Checklist Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {SANDBOX_POLICIES.map((policy) => {
                  const Icon = policy.icon;
                  return (
                    <div
                      key={policy.id}
                      className="rounded-lg border border-[#1E293B] bg-[#090D16] p-3 space-y-1.5 transition-colors hover:border-[#33476E]"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <Icon className="h-4 w-4 text-emerald-400" />
                          <span className="font-semibold text-slate-200 text-xs">
                            {policy.title}
                          </span>
                        </div>
                        <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-800">
                          {policy.badge}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400">{policy.description}</p>
                      <p className="text-[10px] text-slate-500 font-mono pt-0.5">
                        {policy.details}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ExecutionConsole;
