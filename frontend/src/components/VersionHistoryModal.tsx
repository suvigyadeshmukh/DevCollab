import React, { useState, useEffect, useCallback, useRef } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { Socket } from 'socket.io-client';
import {
  GitBranch,
  Plus,
  RotateCcw,
  Clock,
  User,
  Hash,
  ChevronRight,
  X,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  FileCode,
  Eye,
  Layers
} from 'lucide-react';
import {
  CollaboratorRole,
  ProjectFile,
  VersionSnapshot,
  SnapshotFileItem
} from '../types';
import {
  createSnapshot,
  fetchSnapshots,
  restoreSnapshot,
  cn
} from '../services/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface VersionHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  projectName?: string;
  currentFile: ProjectFile | null;
  liveCode: string;
  userRole: CollaboratorRole;
  username: string;
  socket: Socket | null;
  onSnapshotRestored?: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 digest of the given string content and
 * return the first 8 hex characters for use as a short preview hash.
 */
async function computeShortHash(content: string): Promise<string> {
  try {
    const enc = new TextEncoder();
    const data = enc.encode(content);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    const hex = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return hex.slice(0, 8);
  } catch {
    return '--------';
  }
}

function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHrs = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHrs / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHrs < 24) return `${diffHrs}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(isoString).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function getSnapshotFileContent(snapshot: VersionSnapshot, fileName: string): string {
  const match = snapshot.files.find(f => f.name === fileName);
  return match?.content ?? '';
}

function getLanguageForDiff(language: string): string {
  const map: Record<string, string> = {
    typescript: 'typescript',
    ts: 'typescript',
    javascript: 'javascript',
    js: 'javascript',
    python: 'python',
    py: 'python',
    cpp: 'cpp',
    'c++': 'cpp',
    java: 'java',
    rust: 'rust',
    go: 'go',
    shell: 'shell',
    json: 'json',
    html: 'html',
    css: 'css',
    markdown: 'markdown',
    md: 'markdown'
  };
  return map[language.toLowerCase()] ?? 'typescript';
}

// ─── Component ────────────────────────────────────────────────────────────────

export const VersionHistoryModal: React.FC<VersionHistoryModalProps> = ({
  isOpen,
  onClose,
  projectId,
  projectName = 'Untitled Project',
  currentFile,
  liveCode,
  userRole,
  username,
  socket,
  onSnapshotRestored
}) => {
  const [snapshots, setSnapshots] = useState<VersionSnapshot[]>([]);
  const [loadingSnapshots, setLoadingSnapshots] = useState(false);
  const [selectedSnapshot, setSelectedSnapshot] = useState<VersionSnapshot | null>(null);
  const [snapshotHashes, setSnapshotHashes] = useState<Record<string, string>>({});

  const [newSnapshotName, setNewSnapshotName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);

  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState<string | null>(null);

  const [diffMode, setDiffMode] = useState<'split' | 'inline'>('split');
  const [selectedFileInSnap, setSelectedFileInSnap] = useState<string>('');

  const nameInputRef = useRef<HTMLInputElement>(null);
  const canWrite = userRole === 'OWNER' || userRole === 'EDITOR';

  // ── Load snapshots ──────────────────────────────────────────────────────────
  const loadSnapshots = useCallback(async () => {
    setLoadingSnapshots(true);
    try {
      const data = await fetchSnapshots(projectId);
      // Chronological descending — newest first
      const sorted = [...data].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      setSnapshots(sorted);

      // Pre-compute short SHA-256 hashes for each snapshot's current file content
      const hashes: Record<string, string> = {};
      await Promise.all(
        sorted.map(async snap => {
          const allContent = snap.files.map(f => f.content).join('\n');
          hashes[snap.id] = await computeShortHash(allContent);
        })
      );
      setSnapshotHashes(hashes);
    } catch (err: any) {
      console.error('[VersionHistoryModal] Failed to load snapshots:', err);
    } finally {
      setLoadingSnapshots(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (isOpen) {
      loadSnapshots();
      setCreateError(null);
      setCreateSuccess(null);
      setRestoreError(null);
      setRestoreSuccess(null);
      setTimeout(() => nameInputRef.current?.focus(), 120);
    }
  }, [isOpen, loadSnapshots]);

  // Sync selected file when snapshot changes
  useEffect(() => {
    if (selectedSnapshot) {
      const hasCurrentFile = currentFile
        ? selectedSnapshot.files.some(f => f.name === currentFile.name)
        : false;
      setSelectedFileInSnap(
        hasCurrentFile && currentFile
          ? currentFile.name
          : selectedSnapshot.files[0]?.name ?? ''
      );
    }
  }, [selectedSnapshot, currentFile]);

  // ── Create snapshot ─────────────────────────────────────────────────────────
  const handleCreateSnapshot = async () => {
    const label = newSnapshotName.trim();
    if (!label) {
      setCreateError('Snapshot name cannot be empty.');
      return;
    }
    if (label.length > 120) {
      setCreateError('Snapshot name must be 120 characters or fewer.');
      return;
    }

    setIsCreating(true);
    setCreateError(null);
    setCreateSuccess(null);

    try {
      const snap = await createSnapshot(projectId, label);
      setCreateSuccess(`Snapshot "${snap.name}" saved successfully.`);
      setNewSnapshotName('');
      await loadSnapshots();
      // Auto-select the newly created snapshot
      setSelectedSnapshot(snap);
    } catch (err: any) {
      setCreateError(
        err.response?.data?.error ?? err.message ?? 'Failed to create snapshot.'
      );
    } finally {
      setIsCreating(false);
    }
  };

  // ── Restore snapshot ────────────────────────────────────────────────────────
  const handleRestore = async () => {
    if (!selectedSnapshot || !canWrite) return;

    setIsRestoring(true);
    setRestoreError(null);
    setRestoreSuccess(null);

    try {
      const result = await restoreSnapshot(projectId, selectedSnapshot.id);

      // Trigger parent file refresh immediately
      onSnapshotRestored?.();

      // Notify all peers via Socket.IO
      if (socket?.connected) {
        socket.emit('snapshot-restored', {
          projectId,
          snapshotId: selectedSnapshot.id,
          snapshotName: selectedSnapshot.name
        });
      }

      setRestoreSuccess(
        `Restored "${selectedSnapshot.name}" — ${result.restoredFilesCount} file(s) updated. All peers notified.`
      );
    } catch (err: any) {
      setRestoreError(
        err.response?.data?.error ?? err.message ?? 'Restore failed. Please try again.'
      );
    } finally {
      setIsRestoring(false);
    }
  };

  // ── Diff content ────────────────────────────────────────────────────────────
  const diffOriginal = selectedSnapshot
    ? getSnapshotFileContent(selectedSnapshot, selectedFileInSnap)
    : '';

  const diffModified =
    selectedSnapshot && currentFile && selectedFileInSnap === currentFile.name
      ? liveCode
      : selectedSnapshot
      ? getSnapshotFileContent(selectedSnapshot, selectedFileInSnap)
      : liveCode;

  const diffLanguage = getLanguageForDiff(currentFile?.language ?? 'typescript');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/80 backdrop-blur-sm">
      <div className="relative flex w-full max-w-[96vw] flex-col overflow-hidden rounded-xl border border-[#253554] bg-[#090D16] shadow-2xl m-4 my-4">

        {/* ─── Modal Header ─────────────────────────────────────────────── */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-[#1E293B] bg-[#0D1424] px-5 py-3.5">
          <div className="flex items-center space-x-3">
            <div className="flex items-center justify-center rounded-lg bg-indigo-600/20 p-2 border border-indigo-500/30">
              <GitBranch className="h-5 w-5 text-indigo-400" />
            </div>
            <div>
              <h2 className="font-semibold text-slate-100 text-sm">Version History</h2>
              <p className="text-[11px] text-slate-500">
                {projectName} — SHA-256 verified snapshots
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {/* Diff mode toggle */}
            <div className="flex items-center rounded-md border border-[#253554] bg-[#080C14] p-0.5 text-xs">
              <button
                onClick={() => setDiffMode('split')}
                className={cn(
                  'rounded px-2.5 py-1 font-medium transition-colors',
                  diffMode === 'split'
                    ? 'bg-[#1E293B] text-indigo-300'
                    : 'text-slate-500 hover:text-slate-300'
                )}
              >
                Split
              </button>
              <button
                onClick={() => setDiffMode('inline')}
                className={cn(
                  'rounded px-2.5 py-1 font-medium transition-colors',
                  diffMode === 'inline'
                    ? 'bg-[#1E293B] text-indigo-300'
                    : 'text-slate-500 hover:text-slate-300'
                )}
              >
                Inline
              </button>
            </div>

            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-[#1E293B] hover:text-slate-200 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* ─── Modal Body ───────────────────────────────────────────────── */}
        <div className="flex flex-1 overflow-hidden min-h-0">

          {/* ── Left Panel: Snapshot List + Create ──────────────────────── */}
          <div className="flex w-72 flex-shrink-0 flex-col border-r border-[#1E293B] overflow-hidden">

            {/* Create Snapshot Form */}
            <div className="flex-shrink-0 border-b border-[#1E293B] bg-[#0A0F1D] p-3 space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                New Snapshot
              </div>

              <div className="flex space-x-1.5">
                <input
                  ref={nameInputRef}
                  type="text"
                  value={newSnapshotName}
                  onChange={e => {
                    setNewSnapshotName(e.target.value);
                    setCreateError(null);
                    setCreateSuccess(null);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && canWrite && !isCreating) {
                      handleCreateSnapshot();
                    }
                  }}
                  disabled={!canWrite || isCreating}
                  placeholder={canWrite ? 'e.g. v1.2.0 — auth module' : 'VIEWER: read-only'}
                  maxLength={120}
                  className={cn(
                    'flex-1 min-w-0 rounded border bg-[#080C14] px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-600 outline-none transition-colors',
                    canWrite
                      ? 'border-[#253554] focus:border-indigo-500/70'
                      : 'border-[#1A2236] text-slate-500 cursor-not-allowed'
                  )}
                />
                <button
                  onClick={handleCreateSnapshot}
                  disabled={!canWrite || isCreating || !newSnapshotName.trim()}
                  title={!canWrite ? 'VIEWER role cannot create snapshots' : 'Save snapshot'}
                  className={cn(
                    'flex-shrink-0 flex items-center justify-center rounded px-2.5 py-1.5 text-xs font-semibold transition-all border',
                    canWrite && !isCreating && newSnapshotName.trim()
                      ? 'border-indigo-500/60 bg-indigo-600/30 text-indigo-200 hover:bg-indigo-600/50'
                      : 'border-[#1E293B] bg-[#0D1424] text-slate-600 cursor-not-allowed'
                  )}
                >
                  {isCreating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>

              {createError && (
                <div className="flex items-start space-x-1.5 rounded border border-rose-700/50 bg-rose-950/30 px-2 py-1.5 text-[11px] text-rose-300">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-px text-rose-400" />
                  <span>{createError}</span>
                </div>
              )}
              {createSuccess && (
                <div className="flex items-start space-x-1.5 rounded border border-emerald-700/50 bg-emerald-950/30 px-2 py-1.5 text-[11px] text-emerald-300">
                  <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-px text-emerald-400" />
                  <span>{createSuccess}</span>
                </div>
              )}
            </div>

            {/* Snapshot List */}
            <div className="flex-1 overflow-y-auto">
              {loadingSnapshots ? (
                <div className="flex items-center justify-center py-10 text-slate-500 space-x-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-xs">Loading history...</span>
                </div>
              ) : snapshots.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 space-y-2 text-slate-600 px-4 text-center">
                  <Layers className="h-8 w-8 opacity-40" />
                  <p className="text-xs">No snapshots yet.</p>
                  <p className="text-[11px]">Create your first snapshot above.</p>
                </div>
              ) : (
                <ul className="divide-y divide-[#1A2236]">
                  {snapshots.map(snap => {
                    const isSelected = selectedSnapshot?.id === snap.id;
                    const shortHash = snapshotHashes[snap.id] ?? '--------';
                    return (
                      <li key={snap.id}>
                        <button
                          onClick={() => setSelectedSnapshot(snap)}
                          className={cn(
                            'w-full text-left px-3 py-2.5 transition-colors group',
                            isSelected
                              ? 'bg-indigo-950/50 border-l-2 border-indigo-500'
                              : 'hover:bg-[#0F172A] border-l-2 border-transparent'
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className={cn(
                                'truncate text-xs font-semibold',
                                isSelected ? 'text-indigo-300' : 'text-slate-200'
                              )}>
                                {snap.name}
                              </div>
                              <div className="mt-0.5 flex items-center space-x-1.5 text-[10px] text-slate-500">
                                <User className="h-3 w-3 flex-shrink-0" />
                                <span className="truncate">{snap.creator_name ?? snap.created_by}</span>
                              </div>
                              <div className="mt-0.5 flex items-center space-x-2 text-[10px]">
                                <span className="flex items-center space-x-1 text-slate-500">
                                  <Clock className="h-3 w-3" />
                                  <span>{formatRelativeTime(snap.created_at)}</span>
                                </span>
                                <span className="flex items-center space-x-1 font-mono text-slate-600">
                                  <Hash className="h-3 w-3" />
                                  <span>{shortHash}</span>
                                </span>
                              </div>
                              <div className="mt-0.5 text-[10px] text-slate-600">
                                {snap.files.length} file{snap.files.length !== 1 ? 's' : ''}
                              </div>
                            </div>
                            <ChevronRight className={cn(
                              'h-3.5 w-3.5 mt-0.5 flex-shrink-0 transition-colors',
                              isSelected ? 'text-indigo-400' : 'text-slate-700 group-hover:text-slate-500'
                            )} />
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* ── Right Panel: Diff View + Restore ────────────────────────── */}
          <div className="flex flex-1 flex-col overflow-hidden min-w-0">

            {selectedSnapshot ? (
              <>
                {/* Diff Header */}
                <div className="flex flex-shrink-0 items-center justify-between border-b border-[#1E293B] bg-[#0A0F1D] px-4 py-2.5 gap-3">
                  <div className="flex items-center space-x-3 min-w-0">
                    <Eye className="h-4 w-4 flex-shrink-0 text-indigo-400" />
                    <div className="min-w-0">
                      <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                        <span className="text-xs font-semibold text-slate-200 truncate">
                          {selectedSnapshot.name}
                        </span>
                        <span className="text-[10px] text-slate-500">vs</span>
                        <span className="text-[10px] font-medium text-emerald-400">
                          Live CRDT ({username})
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center space-x-3 text-[10px] text-slate-500">
                        <span className="flex items-center space-x-1">
                          <User className="h-3 w-3" />
                          <span>{selectedSnapshot.creator_name ?? selectedSnapshot.created_by}</span>
                        </span>
                        <span className="flex items-center space-x-1">
                          <Clock className="h-3 w-3" />
                          <span>{new Date(selectedSnapshot.created_at).toLocaleString()}</span>
                        </span>
                        <span className="flex items-center space-x-1 font-mono">
                          <Hash className="h-3 w-3" />
                          <span className="text-slate-600">{snapshotHashes[selectedSnapshot.id] ?? '--------'}</span>
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2 flex-shrink-0">
                    {/* File selector if snapshot has multiple files */}
                    {selectedSnapshot.files.length > 1 && (
                      <div className="flex items-center space-x-1.5">
                        <FileCode className="h-3.5 w-3.5 text-slate-500" />
                        <select
                          value={selectedFileInSnap}
                          onChange={e => setSelectedFileInSnap(e.target.value)}
                          className="rounded border border-[#253554] bg-[#080C14] px-2 py-1 text-xs text-slate-200 outline-none focus:border-indigo-500/60"
                        >
                          {selectedSnapshot.files.map((f: SnapshotFileItem) => (
                            <option key={f.name} value={f.name}>{f.name}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Rollback & Restore Button */}
                    <button
                      onClick={handleRestore}
                      disabled={!canWrite || isRestoring}
                      title={
                        !canWrite
                          ? 'VIEWER role cannot restore snapshots'
                          : `Rollback & restore "${selectedSnapshot.name}" to all peers`
                      }
                      className={cn(
                        'flex items-center space-x-1.5 rounded px-3 py-1.5 text-xs font-semibold border transition-all',
                        canWrite && !isRestoring
                          ? 'border-amber-500/60 bg-amber-600/25 text-amber-200 hover:bg-amber-600/40'
                          : 'border-[#1E293B] bg-[#0D1424] text-slate-600 cursor-not-allowed'
                      )}
                    >
                      {isRestoring ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
                          <span>Restoring...</span>
                        </>
                      ) : (
                        <>
                          <RotateCcw className="h-3.5 w-3.5" />
                          <span>Rollback &amp; Restore to All Peers</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Restore feedback */}
                {(restoreError || restoreSuccess) && (
                  <div
                    className={cn(
                      'flex-shrink-0 flex items-start space-x-2 px-4 py-2 text-xs border-b',
                      restoreSuccess
                        ? 'bg-emerald-950/30 border-emerald-800/40 text-emerald-300'
                        : 'bg-rose-950/30 border-rose-800/40 text-rose-300'
                    )}
                  >
                    {restoreSuccess ? (
                      <ShieldCheck className="h-4 w-4 flex-shrink-0 mt-px text-emerald-400" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-px text-rose-400" />
                    )}
                    <span>{restoreSuccess ?? restoreError}</span>
                  </div>
                )}

                {/* Monaco DiffEditor */}
                <div className="flex-1 overflow-hidden min-h-0">
                  <DiffEditor
                    original={diffOriginal}
                    modified={diffMode === 'split' ? diffModified : diffOriginal}
                    language={diffLanguage}
                    theme="vs-dark"
                    options={{
                      readOnly: true,
                      renderSideBySide: diffMode === 'split',
                      fontSize: 12,
                      lineNumbers: 'on',
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                      diffWordWrap: 'on',
                      originalEditable: false,
                      renderIndicators: true,
                      ignoreTrimWhitespace: false,
                      enableSplitViewResizing: true,
                      padding: { top: 8, bottom: 8 }
                    }}
                  />
                </div>
              </>
            ) : (
              /* Empty State */
              <div className="flex flex-1 flex-col items-center justify-center text-slate-600 space-y-3 p-8">
                <div className="rounded-full bg-[#0D1424] border border-[#1E293B] p-5">
                  <GitBranch className="h-10 w-10 opacity-40" />
                </div>
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium text-slate-400">Select a snapshot to compare</p>
                  <p className="text-xs text-slate-600">
                    Choose any saved version from the left to view a side-by-side diff against your live CRDT code.
                  </p>
                </div>
                {snapshots.length === 0 && !loadingSnapshots && (
                  <p className="text-[11px] text-indigo-500/70 border border-indigo-900/40 rounded px-3 py-1.5 bg-indigo-950/20">
                    Create your first snapshot using the form on the left.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default VersionHistoryModal;
