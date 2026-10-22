import React, { useState, useRef } from 'react';
import {
  FileCode,
  Folder,
  Plus,
  Trash2,
  Edit2,
  Lock,
  ChevronLeft,
  Users,
  ShieldCheck,
  Check,
  FileText,
  FileJson,
  Code2,
  AlertCircle,
  Upload,
  UploadCloud,
  Loader2
} from 'lucide-react';
import {
  CollaboratorRole,
  CursorPosition,
  ProjectFile,
  ProjectMember
} from '../types';
import {
  createFile,
  deleteFile,
  updateFile,
  updateCollaboratorRole,
  uploadProjectFile,
  cn
} from '../services/api';

interface SidebarFileTreeProps {
  projectId: string;
  projectName: string;
  userRole: CollaboratorRole;
  files: ProjectFile[];
  selectedFileId: string | null;
  onSelectFile: (file: ProjectFile) => void;
  onRefreshFiles: () => Promise<void>;
  activePeers?: CursorPosition[];
  collaborators?: ProjectMember[];
  onBackToDashboard?: () => void;
}

export const SidebarFileTree: React.FC<SidebarFileTreeProps> = ({
  projectId,
  projectName,
  userRole,
  files,
  selectedFileId,
  onSelectFile,
  onRefreshFiles,
  activePeers = [],
  collaborators = [],
  onBackToDashboard
}) => {
  const isViewer = userRole === 'VIEWER';
  const isOwner = userRole === 'OWNER';

  // Modal / Inline states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [renamingFileId, setRenamingFileId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);

  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Collaborator Role Manager footer expand state
  const [roleManagerOpen, setRoleManagerOpen] = useState(false);
  const [roleUpdateMsg, setRoleUpdateMsg] = useState<string | null>(null);

  // File Upload states
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadFeedback, setUploadFeedback] = useState<{ text: string; isError?: boolean } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Group active peers by fileId
  const peersByFile = activePeers.reduce<Record<string, CursorPosition[]>>((acc, peer) => {
    if (!acc[peer.fileId]) acc[peer.fileId] = [];
    acc[peer.fileId].push(peer);
    return acc;
  }, {});

  // Language Icon Helper
  const getFileIcon = (fileName: string) => {
    const ext = fileName.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'py':
        return <Code2 className="h-4 w-4 text-[#3572A5]" />;
      case 'js':
        return <FileCode className="h-4 w-4 text-[#F7DF1E]" />;
      case 'ts':
        return <FileCode className="h-4 w-4 text-[#3178C6]" />;
      case 'json':
        return <FileJson className="h-4 w-4 text-[#CBCB41]" />;
      case 'md':
        return <FileText className="h-4 w-4 text-[#42A5F5]" />;
      case 'html':
        return <Code2 className="h-4 w-4 text-[#E34C26]" />;
      case 'css':
        return <Code2 className="h-4 w-4 text-[#563D7C]" />;
      default:
        return <FileCode className="h-4 w-4 text-obsidian-400" />;
    }
  };

  // Handle File Creation
  const handleCreateFile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFileName.trim()) return;

    if (isViewer) {
      setCreateError('RBAC Violation: VIEWER role cannot create files.');
      return;
    }

    try {
      setCreating(true);
      setCreateError(null);
      const created = await createFile(projectId, newFileName.trim());
      setShowCreateModal(false);
      setNewFileName('');
      await onRefreshFiles();
      onSelectFile(created);
    } catch (err: any) {
      setCreateError(err.response?.data?.error || err.message || 'File creation failed');
    } finally {
      setCreating(false);
    }
  };

  // Handle File Uploads (Multiple files, size validation, overwrite prompt)
  const handleProcessFiles = async (fileList: FileList | File[]) => {
    if (isViewer) {
      setUploadFeedback({ text: 'RBAC Violation: VIEWER role cannot upload files.', isError: true });
      setTimeout(() => setUploadFeedback(null), 3500);
      return;
    }

    const filesToUpload = Array.from(fileList);
    if (filesToUpload.length === 0) return;

    setUploading(true);
    setUploadFeedback(null);

    let successCount = 0;
    let lastUploaded: ProjectFile | null = null;
    let lastErrorMessage: string | null = null;

    for (const file of filesToUpload) {
      try {
        const result = await uploadProjectFile(projectId, file, false);
        successCount++;
        lastUploaded = result.file;
      } catch (err: any) {
        // If file already exists (409), prompt user to overwrite
        if (err.response?.status === 409) {
          const shouldOverwrite = window.confirm(
            `A file named "${file.name}" already exists in this project. Do you want to overwrite it?`
          );
          if (shouldOverwrite) {
            try {
              const resOverwrite = await uploadProjectFile(projectId, file, true);
              successCount++;
              lastUploaded = resOverwrite.file;
              continue;
            } catch (errOver: any) {
              lastErrorMessage = errOver.response?.data?.error || errOver.message;
            }
          }
        } else {
          lastErrorMessage = err.response?.data?.error || err.message;
        }
      }
    }

    await onRefreshFiles();

    if (lastUploaded) {
      onSelectFile(lastUploaded);
    }

    if (successCount > 0) {
      setUploadFeedback({
        text: `Uploaded ${successCount} file${successCount > 1 ? 's' : ''} successfully!`,
        isError: false
      });
    } else if (lastErrorMessage) {
      setUploadFeedback({ text: lastErrorMessage, isError: true });
    }

    setTimeout(() => setUploadFeedback(null), 4000);
    setUploading(false);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleProcessFiles(e.target.files);
      e.target.value = '';
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isViewer && !isDragging) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (isViewer) {
      setUploadFeedback({ text: 'RBAC Violation: VIEWER role cannot upload files.', isError: true });
      setTimeout(() => setUploadFeedback(null), 3500);
      return;
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleProcessFiles(e.dataTransfer.files);
    }
  };

  // Handle File Rename
  const handleStartRename = (file: ProjectFile, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isViewer) return;
    setRenamingFileId(file.id);
    setRenameValue(file.name);
  };

  const handleSaveRename = async (fileId: string) => {
    if (!renameValue.trim() || isViewer) {
      setRenamingFileId(null);
      return;
    }

    try {
      setRenaming(true);
      await updateFile(projectId, fileId, { name: renameValue.trim() });
      setRenamingFileId(null);
      await onRefreshFiles();
    } catch (err: any) {
      alert(`Rename failed: ${err.response?.data?.error || err.message}`);
    } finally {
      setRenaming(false);
    }
  };

  // Handle File Deletion
  const handleDeleteFile = async (fileId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isViewer) return;

    if (!confirm('Are you sure you want to delete this file? This action is permanent.')) {
      return;
    }

    try {
      setDeleting(true);
      setDeletingFileId(fileId);
      await deleteFile(projectId, fileId);
      await onRefreshFiles();
    } catch (err: any) {
      alert(`Delete failed: ${err.response?.data?.error || err.message}`);
    } finally {
      setDeleting(false);
      setDeletingFileId(null);
    }
  };

  // Handle Role Change (OWNER only)
  const handleRoleChange = async (userId: string, newRole: CollaboratorRole) => {
    if (!isOwner) return;

    try {
      await updateCollaboratorRole(projectId, userId, newRole);
      setRoleUpdateMsg(`Updated role to ${newRole}`);
      setTimeout(() => setRoleUpdateMsg(null), 2500);
      await onRefreshFiles();
    } catch (err: any) {
      alert(`Failed to update role: ${err.response?.data?.error || err.message}`);
    }
  };

  return (
    <aside className="w-64 h-full bg-obsidian-900 border-r border-obsidian-700/80 flex flex-col justify-between select-none">
      {/* ─── Top Header & Project Context ─── */}
      <div className="flex flex-col border-b border-obsidian-700/80">
        {/* Back to Dashboard bar */}
        <div className="h-10 px-3 flex items-center justify-between border-b border-obsidian-800 bg-obsidian-950/60">
          <button
            onClick={onBackToDashboard}
            className="flex items-center space-x-1 text-xs text-obsidian-400 hover:text-white transition"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            <span>Dashboard</span>
          </button>
          <span
            className={cn(
              "text-[9px] font-mono font-bold uppercase px-1.5 py-0.2 rounded border",
              isOwner && "bg-neon-amber/15 text-neon-amber border-neon-amber/30",
              userRole === 'EDITOR' && "bg-neon-cyan/15 text-neon-cyan border-neon-cyan/30",
              isViewer && "bg-neon-violet/15 text-neon-violet border-neon-violet/30"
            )}
          >
            {userRole}
          </span>
        </div>

        {/* Project Name + New File & Upload Buttons */}
        <div className="p-3 flex items-center justify-between">
          <div className="flex items-center space-x-2 min-w-0">
            <Folder className="h-4 w-4 text-neon-cyan shrink-0" />
            <span className="text-xs font-bold text-white truncate" title={projectName}>
              {projectName}
            </span>
          </div>

          <div className="flex items-center space-x-1">
            {/* Hidden file input */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileInputChange}
              multiple
              className="hidden"
            />

            {/* Upload File CTA */}
            <button
              onClick={() => {
                if (isViewer || uploading) return;
                fileInputRef.current?.click();
              }}
              disabled={isViewer || uploading}
              title={isViewer ? 'RBAC Locked: VIEWER cannot upload files' : 'Upload source files (multiple supported)'}
              className={cn(
                "p-1 rounded text-obsidian-400 hover:text-neon-cyan hover:bg-obsidian-800 transition",
                (isViewer || uploading) && "opacity-40 cursor-not-allowed hover:bg-transparent hover:text-obsidian-400"
              )}
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-neon-cyan" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
            </button>

            {/* Create New File CTA */}
            <button
              onClick={() => {
                if (isViewer) return;
                setShowCreateModal(true);
              }}
              disabled={isViewer}
              title={isViewer ? 'RBAC Locked: VIEWER cannot create files' : 'Create new file'}
              className={cn(
                "p-1 rounded text-obsidian-400 hover:text-white hover:bg-obsidian-800 transition",
                isViewer && "opacity-40 cursor-not-allowed hover:bg-transparent hover:text-obsidian-400"
              )}
            >
              {isViewer ? <Lock className="h-3.5 w-3.5 text-obsidian-500" /> : <Plus className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>

      {/* ─── File Explorer Tree (With Drag & Drop Zone) ─── */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "flex-1 overflow-y-auto p-2 space-y-0.5 relative transition-colors",
          isDragging && "bg-neon-cyan/5 ring-1 ring-inset ring-neon-cyan/40"
        )}
      >
        {/* Drag Overlay */}
        {isDragging && (
          <div className="absolute inset-2 z-20 flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-neon-cyan/70 bg-obsidian-950/90 backdrop-blur-sm p-4 text-center pointer-events-none">
            <UploadCloud className="h-8 w-8 text-neon-cyan animate-bounce mb-2" />
            <p className="text-xs font-bold text-white">Drop files to upload</p>
            <p className="text-[10px] text-obsidian-400 mt-1">C++, Python, JS/TS, etc. (max 2MB)</p>
          </div>
        )}

        {/* Upload Feedback Alert */}
        {uploadFeedback && (
          <div
            className={cn(
              "mb-2 p-2 rounded text-[11px] font-medium border flex items-center space-x-1.5 animate-in fade-in",
              uploadFeedback.isError
                ? "bg-rose-950/40 border-rose-500/40 text-rose-300"
                : "bg-emerald-950/40 border-emerald-500/40 text-emerald-300"
            )}
          >
            {uploadFeedback.isError ? (
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
            ) : (
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            )}
            <span className="truncate">{uploadFeedback.text}</span>
          </div>
        )}

        <div className="text-[10px] font-mono text-obsidian-500 px-2 py-1 tracking-wider uppercase font-semibold">
          EXPLORER ({files.length})
        </div>

        {files.length === 0 ? (
          <div className="py-8 text-center text-xs text-obsidian-500 font-mono">
            No files in project
          </div>
        ) : (
          files.map((file) => {
            const isSelected = file.id === selectedFileId;
            const filePeers = peersByFile[file.id] || [];

            return (
              <div
                key={file.id}
                onClick={() => onSelectFile(file)}
                className={cn(
                  "group flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs cursor-pointer transition-all",
                  isSelected
                    ? "bg-obsidian-800 text-white font-medium border border-neon-cyan/30 shadow-sm"
                    : "text-obsidian-300 hover:bg-obsidian-850 hover:text-white border border-transparent"
                )}
              >
                {/* Left: Icon + File Name */}
                <div className="flex items-center space-x-2 min-w-0 flex-1">
                  {getFileIcon(file.name)}

                  {renamingFileId === file.id ? (
                    <input
                      type="text"
                      autoFocus
                      value={renameValue}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => handleSaveRename(file.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveRename(file.id);
                        if (e.key === 'Escape') setRenamingFileId(null);
                      }}
                      className="bg-obsidian-950 border border-neon-cyan rounded px-1 text-xs text-white focus:outline-none w-28"
                    />
                  ) : (
                    <span className="truncate">{file.name}</span>
                  )}
                </div>

                {/* Right: Active Collaborator Dots & Quick Actions */}
                <div className="flex items-center space-x-1 shrink-0">
                  {/* Real-Time Collaborator Dots viewing this file */}
                  {filePeers.length > 0 && (
                    <div className="flex items-center -space-x-1 mr-1">
                      {filePeers.map((peer) => (
                        <span
                          key={peer.userId}
                          title={`${peer.username} is viewing line ${peer.lineNumber}`}
                          className="w-2.5 h-2.5 rounded-full border border-obsidian-900 inline-block"
                          style={{ backgroundColor: peer.color }}
                        />
                      ))}
                    </div>
                  )}

                  {/* Actions for OWNER / EDITOR */}
                  {!isViewer && (
                    <div className="opacity-0 group-hover:opacity-100 flex items-center space-x-1 transition-opacity">
                      <button
                        onClick={(e) => handleStartRename(file, e)}
                        title="Rename file"
                        className="p-1 hover:text-neon-cyan text-obsidian-400"
                      >
                        <Edit2 className="h-3 w-3" />
                      </button>
                      <button
                        onClick={(e) => handleDeleteFile(file.id, e)}
                        title="Delete file"
                        disabled={deleting && deletingFileId === file.id}
                        className="p-1 hover:text-neon-rose text-obsidian-400"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  )}

                  {isViewer && (
                    <span title="Read-only">
                      <Lock className="h-3 w-3 text-obsidian-600 opacity-60" />
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ─── Footer: OWNER Role Manager ─── */}
      <div className="border-t border-obsidian-700/80 bg-obsidian-950/70 p-2.5">
        <button
          onClick={() => setRoleManagerOpen(!roleManagerOpen)}
          className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs font-semibold text-obsidian-300 hover:text-white hover:bg-obsidian-850 transition"
        >
          <div className="flex items-center space-x-2">
            <Users className="h-4 w-4 text-neon-cyan" />
            <span>Role Governance</span>
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-obsidian-800 text-obsidian-400">
              {collaborators.length}
            </span>
          </div>
          {isOwner && (
            <span className="text-[9px] font-mono text-neon-amber font-bold">MANAGE</span>
          )}
        </button>

        {roleUpdateMsg && (
          <div className="mt-1 text-[10px] font-mono text-neon-emerald flex items-center space-x-1 px-2">
            <Check className="h-3 w-3" />
            <span>{roleUpdateMsg}</span>
          </div>
        )}

        {/* Collaborators List & Dropdown */}
        {roleManagerOpen && (
          <div className="mt-2 space-y-1.5 max-h-40 overflow-y-auto pt-2 border-t border-obsidian-800 animate-fade-in">
            {collaborators.length === 0 ? (
              <p className="text-[11px] text-obsidian-500 font-mono px-2">No active collaborators</p>
            ) : (
              collaborators.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between px-2 py-1 rounded bg-obsidian-900 border border-obsidian-800 text-xs"
                >
                  <span className="truncate max-w-[100px] text-obsidian-200 text-[11px]" title={c.username}>
                    {c.username || c.user_id.substring(0, 8)}
                  </span>

                  {isOwner ? (
                    <select
                      value={c.role}
                      onChange={(e) => handleRoleChange(c.user_id, e.target.value as CollaboratorRole)}
                      className="bg-obsidian-950 border border-obsidian-700 rounded px-1.5 py-0.5 text-[10px] font-mono text-white focus:outline-none focus:border-neon-cyan"
                    >
                      <option value="OWNER">OWNER</option>
                      <option value="EDITOR">EDITOR</option>
                      <option value="VIEWER">VIEWER</option>
                    </select>
                  ) : (
                    <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-obsidian-800 text-obsidian-400">
                      {c.role}
                    </span>
                  )}
                </div>
              ))
            )}

            {!isOwner && (
              <p className="text-[10px] text-obsidian-500 font-mono px-2 pt-1 flex items-center space-x-1">
                <Lock className="h-3 w-3 text-obsidian-600" />
                <span>Only OWNER can modify roles</span>
              </p>
            )}
          </div>
        )}
      </div>

      {/* ─── Create File Modal ─── */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-obsidian-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="glass-panel-elevated rounded-xl w-full max-w-sm p-5 border border-obsidian-600 shadow-xl">
            <h4 className="text-sm font-bold text-white mb-1 flex items-center space-x-2">
              <Plus className="h-4 w-4 text-neon-cyan" />
              <span>Create New File</span>
            </h4>
            <p className="text-[11px] text-obsidian-400 mb-3 font-mono">
              Safe naming enforced: Path traversal (..), null bytes, and dotfiles are prohibited.
            </p>

            {createError && (
              <div className="p-2 rounded bg-neon-rose/10 border border-neon-rose/30 text-neon-rose text-xs font-mono mb-3 flex items-center space-x-1.5">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span>{createError}</span>
              </div>
            )}

            <form onSubmit={handleCreateFile} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-obsidian-300 mb-1">
                  File Name
                </label>
                <input
                  type="text"
                  autoFocus
                  required
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  placeholder="e.g. optimizer.py, service.ts"
                  className="w-full bg-obsidian-950 border border-obsidian-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-neon-cyan font-mono"
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    fileInputRef.current?.click();
                  }}
                  className="flex items-center space-x-1 text-[11px] text-neon-cyan hover:underline"
                >
                  <Upload className="h-3 w-3" />
                  <span>Or upload from disk</span>
                </button>

                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    className="px-3 py-1.5 rounded-lg text-xs text-obsidian-400 hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={creating || !newFileName.trim()}
                    className="px-4 py-1.5 rounded-lg bg-neon-cyan text-obsidian-950 font-bold text-xs uppercase tracking-wider disabled:opacity-50 transition"
                  >
                    {creating ? 'Creating...' : 'Create'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </aside>
  );
};
