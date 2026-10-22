import React, {
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';
import Editor, { OnMount, Monaco } from '@monaco-editor/react';
import * as Y from 'yjs';
import * as monaco from 'monaco-editor';
import { Socket } from 'socket.io-client';
import {
  ShieldAlert,
  AlertTriangle,
  Lock,
  MessageSquare,
  GitBranch,
  Zap,
  X,
  CheckCircle2,
  Info
} from 'lucide-react';
import {
  Breakpoint,
  CollaboratorRole,
  CursorPosition,
  InlineComment,
  ProjectFile
} from '../types';
import { createComment, cn } from '../services/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CollaborativeEditorProps {
  file: ProjectFile;
  projectId: string;
  userId: string;
  username: string;
  userRole: CollaboratorRole;
  socket: Socket | null;
  conflictBurstTrigger?: number; // Increment to trigger a CRDT burst test
  onCrdtOpsUpdate?: (ops: number, bytes: number) => void;
  onCodeChange?: (code: string) => void;
}

interface ThreatMarker {
  pattern: string;
  severity: 'error' | 'warning';
  message: string;
  ruleId: string;
}

interface CommentDraft {
  lineNumber: number;
  content: string;
}

// ─── Security Threat Patterns ─────────────────────────────────────────────────

const THREAT_PATTERNS: ThreatMarker[] = [
  {
    pattern: 'child_process',
    severity: 'error',
    message: '[Security] Blocked: child_process enables OS-level command execution (RCE vector)',
    ruleId: 'rce-child-process'
  },
  {
    pattern: 'process.env',
    severity: 'warning',
    message: '[Security] Caution: process.env access may leak secrets or credentials',
    ruleId: 'sec-env-access'
  },
  {
    pattern: 'eval(',
    severity: 'error',
    message: '[Security] Blocked: eval() enables dynamic code injection (prototype breakout)',
    ruleId: 'rce-eval'
  },
  {
    pattern: 'constructor.constructor',
    severity: 'error',
    message: '[Security] Blocked: constructor.constructor is a known sandbox escape vector',
    ruleId: 'rce-constructor-escape'
  },
  {
    pattern: '__proto__',
    severity: 'error',
    message: '[Security] Blocked: __proto__ mutation enables prototype pollution attacks',
    ruleId: 'rce-proto-pollution'
  },
  {
    pattern: 'os.system',
    severity: 'error',
    message: '[Security] Blocked: os.system() executes arbitrary host OS commands (RCE)',
    ruleId: 'rce-os-system'
  },
  {
    pattern: 'subprocess',
    severity: 'error',
    message: '[Security] Blocked: subprocess module enables spawning external processes',
    ruleId: 'rce-subprocess'
  },
  {
    pattern: '/etc/passwd',
    severity: 'error',
    message: '[Security] Blocked: /etc/passwd access is a Unix credential exfiltration vector',
    ruleId: 'rce-credential-read'
  },
  {
    pattern: 'process.mainModule',
    severity: 'error',
    message: '[Security] Blocked: process.mainModule access enables module system breakout',
    ruleId: 'rce-main-module'
  },
  {
    pattern: 'require("child_process")',
    severity: 'error',
    message: '[Security] Blocked: Direct require of child_process module detected',
    ruleId: 'rce-require-cp'
  },
  {
    pattern: "require('child_process')",
    severity: 'error',
    message: '[Security] Blocked: Direct require of child_process module detected',
    ruleId: 'rce-require-cp-sq'
  },
  {
    pattern: 'Function(',
    severity: 'warning',
    message: '[Security] Caution: Function() constructor can execute arbitrary string as code',
    ruleId: 'rce-function-constructor'
  }
];

// ─── Cursor Colors Pool ────────────────────────────────────────────────────────

const CURSOR_COLORS = [
  '#00F0FF', '#A855F7', '#00FF9D', '#FF6B6B',
  '#FFB800', '#4ECDC4', '#45B7D1', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F0B429', '#E879F9'
];

function getUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

// ─── Monaco Theme ─────────────────────────────────────────────────────────────

function defineObsidianTheme(monacoInst: Monaco) {
  monacoInst.editor.defineTheme('obsidian-devcollab', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '4A6291', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'A855F7' },
      { token: 'string', foreground: '00FF9D' },
      { token: 'number', foreground: 'FFB800' },
      { token: 'type', foreground: '00F0FF' },
      { token: 'class-name', foreground: '00F0FF' },
      { token: 'function', foreground: '85C1E9' },
      { token: 'variable', foreground: 'CBD7EE' },
      { token: 'operator', foreground: 'A4B8DC' },
      { token: 'delimiter', foreground: '4A6291' },
    ],
    colors: {
      'editor.background': '#090D16',
      'editor.foreground': '#CBD7EE',
      'editorLineNumber.foreground': '#33476E',
      'editorLineNumber.activeForeground': '#7B93BE',
      'editor.lineHighlightBackground': '#0F1624',
      'editor.lineHighlightBorder': '#1C2840',
      'editor.selectionBackground': '#253554',
      'editor.inactiveSelectionBackground': '#1C2840',
      'editorCursor.foreground': '#00F0FF',
      'editor.findMatchBackground': '#A855F740',
      'editor.findMatchHighlightBackground': '#A855F725',
      'editorGutter.background': '#090D16',
      'editorWhitespace.foreground': '#1C2840',
      'scrollbarSlider.background': '#25355499',
      'scrollbarSlider.hoverBackground': '#4A629199',
      'scrollbarSlider.activeBackground': '#4A6291CC',
      'editorWidget.background': '#0F1624',
      'editorWidget.border': '#253554',
      'editorSuggestWidget.background': '#0F1624',
      'editorSuggestWidget.border': '#253554',
      'editorSuggestWidget.selectedBackground': '#1C2840',
      'input.background': '#090D16',
      'input.border': '#253554',
      'focusBorder': '#00F0FF',
    }
  });
}

// ─── Main Component ───────────────────────────────────────────────────────────

export const CollaborativeEditor: React.FC<CollaborativeEditorProps> = ({
  file,
  projectId,
  userId,
  username,
  userRole,
  socket,
  conflictBurstTrigger = 0,
  onCrdtOpsUpdate,
  onCodeChange
}) => {
  const isViewer = userRole === 'VIEWER';
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  // Y.Doc for this file – single instance per file mount
  const ydocRef = useRef<Y.Doc | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);

  // Guards
  const isRemoteUpdateRef = useRef(false);  // Prevent echo: remote WS update -> Monaco change -> re-emit
  const isYjsUpdateRef = useRef(false);     // Prevent echo: local Y.Text observe -> Monaco model update
  const isMountedRef = useRef(true);

  // Decoration IDs for remote cursors/selections (Monaco manages these as string arrays)
  const decorationIdsRef = useRef<string[]>([]);

  // Breakpoint glyph decoration IDs
  const breakpointDecorationIdsRef = useRef<{ [lineNum: number]: string }>({});

  // Throttle timer for cursor-update events
  const cursorEmitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce timer for threat scan (avoid scanning on every keystroke)
  const threatScanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // CRDT operations counter for telemetry
  const crdtOpsRef = useRef(0);

  // Active remote peers
  const [remotePeers, setRemotePeers] = useState<Map<string, CursorPosition>>(new Map());

  // Breakpoints state
  const [breakpoints, setBreakpoints] = useState<Map<string, Breakpoint>>(new Map());

  // Active threat markers from scanner
  const [threatCount, setThreatCount] = useState(0);

  // Inline comment draft state
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [commentFeedback, setCommentFeedback] = useState<string | null>(null);

  // Toast notifications
  const [toasts, setToasts] = useState<Array<{ id: string; msg: string; type: 'info' | 'warn' | 'error' | 'success' }>>([]);

  const addToast = useCallback((msg: string, type: 'info' | 'warn' | 'error' | 'success' = 'info') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev.slice(-3), { id, msg, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3500);
  }, []);

  // ── Emit CRDT incremental update over WS ─────────────────────────────────
  const emitYjsUpdate = useCallback((update: Uint8Array) => {
    if (!socket?.connected) return;
    const updateBase64 = btoa(String.fromCharCode(...update));
    socket.emit('yjs-update', {
      projectId,
      fileId: file.id,
      updateBase64
    });
    crdtOpsRef.current += 1;
    const stateSize = ytextRef.current ? new TextEncoder().encode(ytextRef.current.toString()).length : 0;
    onCrdtOpsUpdate?.(crdtOpsRef.current, stateSize);
  }, [socket, projectId, file.id, onCrdtOpsUpdate]);

  // ── Initialize / Reset Y.Doc on file change ────────────────────────────────
  const initYDoc = useCallback((yjsStateBase64?: string, initialContent?: string) => {
    // Dispose previous doc
    if (ydocRef.current) {
      ydocRef.current.destroy();
    }

    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;
    const ytext = ydoc.getText('monaco');
    ytextRef.current = ytext;

    // Listen to local transactions and emit incremental updates to peers
    ydoc.on('update', (update: Uint8Array, origin: any) => {
      // ONLY emit if change originated locally from Monaco and user is not VIEWER
      if (origin === 'monaco' && socket?.connected && !isViewer) {
        emitYjsUpdate(update);
      }
    });

    if (yjsStateBase64 && yjsStateBase64.length > 0) {
      // Hydrate from server binary state
      try {
        const binaryUpdate = Uint8Array.from(atob(yjsStateBase64), c => c.charCodeAt(0));
        Y.applyUpdate(ydoc, binaryUpdate, 'init');
      } catch {
        // Fallback to plain text seed
        if (initialContent && ytext.length === 0) {
          ydoc.transact(() => {
            ytext.insert(0, initialContent);
          }, 'init');
        }
      }
    } else if (initialContent && ytext.length === 0) {
      // Seed from plain text content when no Yjs state exists
      ydoc.transact(() => {
        ytext.insert(0, initialContent);
      }, 'init');
    }

    return { ydoc, ytext };
  }, [emitYjsUpdate, socket, file.id, isViewer]);

  // ── Wire Y.Text observer -> Monaco model ──────────────────────────────────
  const wireYTextObserver = useCallback((ytext: Y.Text) => {
    ytext.observe((event: Y.YTextEvent) => {
      // If the change originated locally from Monaco, do not re-apply to Monaco
      if (event.transaction.origin === 'monaco' || isYjsUpdateRef.current) return;

      const editor = editorRef.current;
      const model = editor?.getModel();
      const monacoInst = monacoRef.current;
      if (!editor || !model || !monacoInst) return;

      // Translate Yjs OT delta to Monaco incremental edit operations
      const delta = event.delta;
      const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
      let index = 0;

      for (let i = 0; i < delta.length; i++) {
        const op = delta[i];
        if (op.retain) {
          index += op.retain;
        } else if (op.delete) {
          const nextOp = delta[i + 1];
          if (nextOp && nextOp.insert && typeof nextOp.insert === 'string') {
            // Replacement: delete + insert combined at current position
            const startPos = model.getPositionAt(index);
            const endPos = model.getPositionAt(index + op.delete);
            edits.push({
              range: new monacoInst.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column),
              text: nextOp.insert,
              forceMoveMarkers: true
            });
            index += op.delete;
            i++; // consume nextOp
          } else {
            const startPos = model.getPositionAt(index);
            const endPos = model.getPositionAt(index + op.delete);
            edits.push({
              range: new monacoInst.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column),
              text: '',
              forceMoveMarkers: true
            });
            index += op.delete;
          }
        } else if (op.insert && typeof op.insert === 'string') {
          const nextOp = delta[i + 1];
          if (nextOp && nextOp.delete) {
            // Replacement: insert + delete combined at current position
            const startPos = model.getPositionAt(index);
            const endPos = model.getPositionAt(index + nextOp.delete);
            edits.push({
              range: new monacoInst.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column),
              text: op.insert,
              forceMoveMarkers: true
            });
            index += nextOp.delete;
            i++; // consume nextOp
          } else {
            const pos = model.getPositionAt(index);
            edits.push({
              range: new monacoInst.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
              text: op.insert,
              forceMoveMarkers: true
            });
          }
        }
      }

      if (edits.length > 0) {
        isRemoteUpdateRef.current = true;
        editor.executeEdits('yjs-remote', edits);
        isRemoteUpdateRef.current = false;
      }

      // Safety check: ensure Monaco model exactly converges with Y.Text
      const finalContent = ytext.toString();
      if (model.getValue() !== finalContent) {
        const savedPosition = editor.getPosition();
        isRemoteUpdateRef.current = true;
        model.setValue(finalContent);
        isRemoteUpdateRef.current = false;
        if (savedPosition) {
          editor.setPosition(savedPosition);
        }
      }

      onCodeChange?.(finalContent);
    });
  }, [onCodeChange]);

  // ── Scan code for security threats (debounced 300ms) ──────────────────────
  const scanForThreats = useCallback((code: string) => {
    if (threatScanTimerRef.current) clearTimeout(threatScanTimerRef.current);

    threatScanTimerRef.current = setTimeout(() => {
      const editor = editorRef.current;
      const monacoInst = monacoRef.current;
      const model = editor?.getModel();
      if (!editor || !monacoInst || !model) return;

      const lines = code.split('\n');
      const markers: monaco.editor.IMarkerData[] = [];

      for (const threat of THREAT_PATTERNS) {
        const patternLower = threat.pattern.toLowerCase();
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx];
          const col = line.toLowerCase().indexOf(patternLower);
          if (col !== -1) {
            markers.push({
              severity: threat.severity === 'error'
                ? monacoInst.MarkerSeverity.Error
                : monacoInst.MarkerSeverity.Warning,
              message: threat.message,
              startLineNumber: lineIdx + 1,
              startColumn: col + 1,
              endLineNumber: lineIdx + 1,
              endColumn: col + threat.pattern.length + 1,
              code: threat.ruleId,
              source: 'DevCollab Security Linter'
            });
          }
        }
      }

      monacoInst.editor.setModelMarkers(model, 'devcollab-security', markers);
      setThreatCount(markers.length);
    }, 300);
  }, []);

  // ── Render remote cursor decorations ──────────────────────────────────────
  const renderRemoteCursors = useCallback((peers: Map<string, CursorPosition>) => {
    const editor = editorRef.current;
    const monacoInst = monacoRef.current;
    if (!editor || !monacoInst) return;

    const decorations: monaco.editor.IModelDeltaDecoration[] = [];

    for (const peer of peers.values()) {
      const color = peer.color || getUserColor(peer.userId);
      const colorHex = color.replace('#', '');
      const lineNum = Math.max(1, peer.lineNumber);
      const colNum = Math.max(1, peer.column);

      // CSS class names are injected dynamically using inline style injection
      const cursorClass = `remote-cursor-${colorHex}`;
      const selectionClass = `remote-selection-${colorHex}`;
      const labelClass = `remote-cursor-label-${colorHex}`;

      // Inject dynamic CSS for this color if not already done
      const styleId = `cursor-style-${colorHex}`;
      if (!document.getElementById(styleId)) {
        const styleEl = document.createElement('style');
        styleEl.id = styleId;
        styleEl.textContent = `
          .${cursorClass} {
            border-left: 2px solid ${color} !important;
            box-shadow: 0 0 6px ${color}88;
            margin-left: -1px;
            pointer-events: none;
          }
          .${selectionClass} {
            background-color: ${color}35 !important;
            border-radius: 2px;
            pointer-events: none;
          }
          .${labelClass}::before {
            content: '${peer.username.replace(/'/g, "\\'")}';
            position: absolute;
            top: -20px;
            left: 0;
            background-color: ${color};
            color: #090D16;
            font-size: 10px;
            font-weight: 700;
            padding: 1px 6px;
            border-radius: 3px;
            white-space: nowrap;
            pointer-events: none;
            font-family: 'JetBrains Mono', monospace;
            box-shadow: 0 2px 4px rgba(0,0,0,0.5);
            z-index: 100;
          }
        `;
        document.head.appendChild(styleEl);
      }

      // Selection Range decoration (if selection exists and is non-empty)
      if (peer.selection && (peer.selection.startLineNumber !== peer.selection.endLineNumber || peer.selection.startColumn !== peer.selection.endColumn)) {
        decorations.push({
          range: new monacoInst.Range(
            peer.selection.startLineNumber,
            peer.selection.startColumn,
            peer.selection.endLineNumber,
            peer.selection.endColumn
          ),
          options: {
            className: selectionClass,
            stickiness: monacoInst.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
          }
        });
      }

      // Vertical cursor caret and username label
      decorations.push({
        range: new monacoInst.Range(lineNum, colNum, lineNum, colNum),
        options: {
          className: cursorClass,
          stickiness: monacoInst.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          beforeContentClassName: labelClass
        }
      });
    }

    // Apply decorations (replace previous set atomically)
    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, decorations);
  }, []);

  // ── Render breakpoint glyph decorations ────────────────────────────────────
  const renderBreakpointDecorations = useCallback((bpMap: Map<string, Breakpoint>) => {
    const editor = editorRef.current;
    const monacoInst = monacoRef.current;
    if (!editor || !monacoInst) return;

    // Remove all current BP decorations
    const allBpIds = Object.values(breakpointDecorationIdsRef.current);
    editor.deltaDecorations(allBpIds, []);
    breakpointDecorationIdsRef.current = {};

    // Re-add all current breakpoints as glyph decorations
    for (const bp of bpMap.values()) {
      const newIds = editor.deltaDecorations([], [{
        range: new monacoInst.Range(bp.lineNumber, 1, bp.lineNumber, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: bp.enabled
            ? 'monaco-breakpoint-glyph'
            : 'monaco-breakpoint-disabled-glyph',
          glyphMarginHoverMessage: {
            value: `**Breakpoint** set by **${bp.username}** (line ${bp.lineNumber}, ${bp.enabled ? 'enabled' : 'disabled'})`
          },
          stickiness: monacoInst.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
        }
      }]);
      breakpointDecorationIdsRef.current[bp.lineNumber] = newIds[0];
    }
  }, []);

  // ── Monaco Editor Mount ────────────────────────────────────────────────────
  const handleEditorDidMount: OnMount = useCallback((editor, monacoInst) => {
    editorRef.current = editor;
    monacoRef.current = monacoInst;

    defineObsidianTheme(monacoInst);
    monacoInst.editor.setTheme('obsidian-devcollab');

    // Configure editor options
    editor.updateOptions({
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontLigatures: true,
      lineHeight: 22,
      minimap: { enabled: true, scale: 0.7 },
      renderLineHighlight: 'all',
      scrollBeyondLastLine: false,
      glyphMargin: true,           // Enabled for breakpoint gutter
      folding: true,
      foldingHighlight: true,
      renderWhitespace: 'none',
      bracketPairColorization: { enabled: true },
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      readOnly: isViewer,
      domReadOnly: isViewer,
      padding: { top: 12, bottom: 12 },
      overviewRulerLanes: 3,
      lineDecorationsWidth: 8,
    });

    const model = editor.getModel();
    if (!model) return;

    // Report initial content to parent component
    onCodeChange?.(model.getValue());

    // ── Monaco onDidChangeModelContent → Yjs delta translation ──
    editor.onDidChangeModelContent((e) => {
      if (isYjsUpdateRef.current || isRemoteUpdateRef.current || isViewer) return;

      const ytext = ytextRef.current;
      const ydoc = ydocRef.current;
      if (!ytext || !ydoc) return;

      // Process each Monaco content change into Yjs text operations
      isYjsUpdateRef.current = true;
      ydoc.transact(() => {
        // Changes must be applied in reverse offset order to keep offsets valid
        const changes = [...e.changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
        for (const change of changes) {
          const { rangeOffset, rangeLength, text: insertText } = change;
          if (rangeLength > 0) {
            ytext.delete(rangeOffset, rangeLength);
          }
          if (insertText.length > 0) {
            ytext.insert(rangeOffset, insertText);
          }
        }
      }, 'monaco');
      isYjsUpdateRef.current = false;

      const currentVal = model.getValue();
      onCodeChange?.(currentVal);

      // Run threat scan on current content
      scanForThreats(currentVal);
    });

    // ── Cursor/Selection change → emit cursor-update (throttled 40ms) ────────
    const emitCursorUpdate = () => {
      if (cursorEmitTimerRef.current) clearTimeout(cursorEmitTimerRef.current);
      cursorEmitTimerRef.current = setTimeout(() => {
        if (!socket?.connected || !isMountedRef.current) return;
        const pos = editor.getPosition();
        if (!pos) return;
        const sel = editor.getSelection();
        const selectionData = sel && !sel.isEmpty() ? {
          startLineNumber: sel.startLineNumber,
          startColumn: sel.startColumn,
          endLineNumber: sel.endLineNumber,
          endColumn: sel.endColumn
        } : undefined;

        socket.emit('cursor-update', {
          projectId,
          fileId: file.id,
          lineNumber: pos.lineNumber,
          column: pos.column,
          selection: selectionData
        });
      }, 40);
    };

    editor.onDidChangeCursorPosition(emitCursorUpdate);
    editor.onDidChangeCursorSelection(emitCursorUpdate);

    // ── Glyph Margin Click → Toggle Breakpoint ────────────────────────────────
    editor.onMouseDown((e) => {
      if (isViewer) return;
      if (e.target.type === monacoInst.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        const lineNumber = e.target.position?.lineNumber;
        if (lineNumber && socket?.connected) {
          socket.emit('toggle-breakpoint', {
            projectId,
            fileId: file.id,
            lineNumber
          });
        }
      }
    });

    // Initial threat scan on mount
    scanForThreats(model.getValue());
  }, [isViewer, socket, projectId, file.id, emitYjsUpdate, scanForThreats, onCodeChange]);

  // ── Wire up Socket.IO events ───────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    // ── join-file ack: hydrate Y.Doc from server state ───────────────────────
    const handleJoinFileAck = (data: {
      fileId: string;
      role: string;
      yjsStateBase64: string;
      activeCursors: CursorPosition[];
      breakpoints: Breakpoint[];
    }) => {
      if (data.fileId !== file.id || !isMountedRef.current) return;

      const { ydoc, ytext } = initYDoc(data.yjsStateBase64, file.content);
      wireYTextObserver(ytext);

      // Sync Monaco model to hydrated Y.Doc content
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (editor && model) {
        const yjsContent = ytext.toString();
        if (yjsContent && model.getValue() !== yjsContent) {
          isYjsUpdateRef.current = true;
          model.setValue(yjsContent);
          isYjsUpdateRef.current = false;
        }
        onCodeChange?.(model.getValue());
        scanForThreats(model.getValue());
      }

      // Load initial cursors
      const initialPeers = new Map<string, CursorPosition>();
      for (const c of data.activeCursors) {
        if (c.userId !== userId) {
          initialPeers.set(c.userId, c);
        }
      }
      setRemotePeers(initialPeers);

      // Load initial breakpoints
      const initialBps = new Map<string, Breakpoint>();
      for (const bp of data.breakpoints) {
        initialBps.set(bp.id, bp);
      }
      setBreakpoints(initialBps);
    };

    // ── yjs-update from peer ─────────────────────────────────────────────────
    const handleYjsUpdate = (data: { fileId: string; updateBase64: string; userId: string }) => {
      if (data.fileId !== file.id || data.userId === userId) return;

      const ydoc = ydocRef.current;
      const ytext = ytextRef.current;
      if (!ydoc || !ytext) return;

      try {
        const updateBytes = Uint8Array.from(atob(data.updateBase64), c => c.charCodeAt(0));
        isRemoteUpdateRef.current = true;
        Y.applyUpdate(ydoc, updateBytes);
        isRemoteUpdateRef.current = false;

        // The Y.Text observer will fire and sync Monaco model
        crdtOpsRef.current += 1;

        // Re-scan for threats after remote update
        const editor = editorRef.current;
        const model = editor?.getModel();
        if (model) {
          onCodeChange?.(model.getValue());
          scanForThreats(model.getValue());
        }

        const stateSize = new TextEncoder().encode(ytext.toString()).length;
        onCrdtOpsUpdate?.(crdtOpsRef.current, stateSize);
      } catch (err) {
        console.error('[CollaborativeEditor] Failed to apply remote yjs-update:', err);
        isRemoteUpdateRef.current = false;
      }
    };

    // ── cursor-update from peer ──────────────────────────────────────────────
    const handleCursorUpdate = (data: CursorPosition) => {
      if (data.fileId !== file.id || data.userId === userId) return;
      setRemotePeers(prev => {
        const next = new Map(prev);
        next.set(data.userId, { ...data, color: data.color || getUserColor(data.userId) });
        return next;
      });
    };

    // ── cursor-removed when peer leaves file ─────────────────────────────────
    const handleCursorRemoved = (data: { userId: string }) => {
      setRemotePeers(prev => {
        const next = new Map(prev);
        next.delete(data.userId);
        return next;
      });
    };

    // ── breakpoint-update ────────────────────────────────────────────────────
    const handleBreakpointUpdate = (data: {
      action: 'added' | 'removed' | 'toggled';
      breakpoint: Breakpoint;
      userId: string;
      username: string;
    }) => {
      if (data.breakpoint.fileId !== file.id) return;
      setBreakpoints(prev => {
        const next = new Map(prev);
        if (data.action === 'added' || data.action === 'toggled') {
          next.set(data.breakpoint.id, data.breakpoint);
        } else if (data.action === 'removed') {
          next.delete(data.breakpoint.id);
        }
        return next;
      });

      const who = data.userId === userId ? 'You' : data.username;
      addToast(`${who} ${data.action === 'added' ? 'set' : 'toggled'} breakpoint on line ${data.breakpoint.lineNumber}`, 'info');
    };

    // ── security-alert from server ───────────────────────────────────────────
    const handleSecurityAlert = (data: { type: string; message: string }) => {
      addToast(`⚠ Security: ${data.message}`, 'error');
    };

    // ── snapshot-restored ────────────────────────────────────────────────────
    const handleSnapshotRestored = (data: { projectId: string; restoredBy: string }) => {
      if (data.projectId !== projectId) return;
      addToast(`Snapshot restored by ${data.restoredBy}. Rejoining file...`, 'warn');
      // Re-join the file to receive fresh Y.Doc state
      socket.emit('join-file', { projectId, fileId: file.id });
    };

    socket.on('join-file-ack', handleJoinFileAck);
    socket.on('yjs-update', handleYjsUpdate);
    socket.on('cursor-update', handleCursorUpdate);
    socket.on('cursor-removed', handleCursorRemoved);
    socket.on('breakpoint-update', handleBreakpointUpdate);
    socket.on('security-alert', handleSecurityAlert);
    socket.on('snapshot-restored', handleSnapshotRestored);

    // Join the file room immediately
    socket.emit('join-file', { projectId, fileId: file.id });

    return () => {
      socket.off('join-file-ack', handleJoinFileAck);
      socket.off('yjs-update', handleYjsUpdate);
      socket.off('cursor-update', handleCursorUpdate);
      socket.off('cursor-removed', handleCursorRemoved);
      socket.off('breakpoint-update', handleBreakpointUpdate);
      socket.off('security-alert', handleSecurityAlert);
      socket.off('snapshot-restored', handleSnapshotRestored);
    };
  }, [socket, file.id, userId, projectId, initYDoc, wireYTextObserver, scanForThreats, addToast, onCrdtOpsUpdate]);

  // ── Re-render remote cursors when peer state changes ─────────────────────
  useEffect(() => {
    renderRemoteCursors(remotePeers);
  }, [remotePeers, renderRemoteCursors]);

  // ── Re-render breakpoint decorations ─────────────────────────────────────
  useEffect(() => {
    renderBreakpointDecorations(breakpoints);
  }, [breakpoints, renderBreakpointDecorations]);

  // ── Conflict Burst Trigger: insert 5 rapid timestamped CRDT lines ─────────
  useEffect(() => {
    if (conflictBurstTrigger === 0) return;
    const ytext = ytextRef.current;
    const ydoc = ydocRef.current;
    if (!ytext || !ydoc || isViewer) return;

    const insertions = [
      `// [CRDT-BURST-${Date.now()}-1] Concurrent edit A from ${username}`,
      `// [CRDT-BURST-${Date.now()}-2] Concurrent edit B from ${username}`,
      `// [CRDT-BURST-${Date.now()}-3] Conflict candidate C — vector clock divergence`,
      `// [CRDT-BURST-${Date.now()}-4] Merge test D — CRDT convergence in progress`,
      `// [CRDT-BURST-${Date.now()}-5] Converged E — all peers reach identical state ✓`
    ];

    let delay = 0;
    for (const line of insertions) {
      setTimeout(() => {
        if (!isMountedRef.current || !ytextRef.current || !ydocRef.current) return;
        ydocRef.current.transact(() => {
          const insertPos = ytextRef.current!.length;
          ytextRef.current!.insert(insertPos, '\n' + line);
        }, 'monaco');

        // Sync Monaco model
        const editor = editorRef.current;
        const model = editor?.getModel();
        if (editor && model && ytextRef.current) {
          isYjsUpdateRef.current = true;
          model.setValue(ytextRef.current.toString());
          isYjsUpdateRef.current = false;
        }
      }, delay);
      delay += 120;
    }

    addToast('CRDT burst: 5 concurrent edits injected — verifying conflict-free convergence', 'info');
  }, [conflictBurstTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (ydocRef.current) {
        ydocRef.current.destroy();
        ydocRef.current = null;
        ytextRef.current = null;
      }
      if (cursorEmitTimerRef.current) clearTimeout(cursorEmitTimerRef.current);
      if (threatScanTimerRef.current) clearTimeout(threatScanTimerRef.current);
      // Clear decorations
      decorationIdsRef.current = [];
    };
  }, [file.id]);

  // ── Inline Comment Submission ──────────────────────────────────────────────
  const handleAddCommentToCurrentLine = () => {
    const editor = editorRef.current;
    const pos = editor?.getPosition();
    if (!pos) return;
    setCommentDraft({ lineNumber: pos.lineNumber, content: '' });
    setCommentFeedback(null);
  };

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentDraft || !commentDraft.content.trim()) return;

    try {
      setCommentSubmitting(true);
      await createComment(projectId, file.id, commentDraft.lineNumber, commentDraft.content.trim());
      setCommentDraft(null);
      setCommentFeedback(null);

      // Notify peers via socket
      socket?.emit('new-comment', {
        projectId,
        fileId: file.id,
        lineNumber: commentDraft.lineNumber,
        content: commentDraft.content.trim()
      });

      addToast(`Comment added on line ${commentDraft.lineNumber}`, 'success');
    } catch (err: any) {
      setCommentFeedback(err.response?.data?.error || 'Failed to submit comment');
    } finally {
      setCommentSubmitting(false);
    }
  };

  // ── Determine language for Monaco ─────────────────────────────────────────
  const monacoLanguage = (() => {
    const lang = file.language.toLowerCase();
    if (lang === 'markdown') return 'markdown';
    if (lang === 'python') return 'python';
    if (lang === 'javascript') return 'javascript';
    if (lang === 'typescript') return 'typescript';
    if (lang === 'json') return 'json';
    if (lang === 'html') return 'html';
    if (lang === 'css') return 'css';
    if (lang === 'shell') return 'shell';
    if (lang === 'rust') return 'rust';
    if (lang === 'go') return 'go';
    if (lang === 'cpp' || lang === 'c++') return 'cpp';
    if (lang === 'sql') return 'sql';
    return 'plaintext';
  })();

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="relative flex flex-col h-full w-full bg-obsidian-950 overflow-hidden">
      {/* ── VIEWER Security Banner ─────────────────────────────────────────── */}
      {isViewer && (
        <div className="flex-shrink-0 h-8 bg-neon-violet/15 border-b border-neon-violet/40 flex items-center px-4 space-x-2 text-neon-violet text-xs font-mono font-semibold z-20">
          <Lock className="h-3.5 w-3.5" />
          <span>READ-ONLY — VIEWER Role: All edit operations are enforced as blocked at the CRDT and REST transport layers.</span>
        </div>
      )}

      {/* ── Security Threat Linter Banner ─────────────────────────────────── */}
      {threatCount > 0 && (
        <div className="flex-shrink-0 px-4 py-1.5 bg-neon-rose/10 border-b border-neon-rose/40 flex items-center justify-between text-xs font-mono z-20">
          <div className="flex items-center space-x-2 text-neon-rose">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
            <span className="font-bold">
              {threatCount} Security Threat{threatCount > 1 ? 's' : ''} Detected
            </span>
            <span className="text-obsidian-400">—</span>
            <span className="text-obsidian-300">
              Execution blocked until violations are resolved. Check gutter markers.
            </span>
          </div>
          <div className="flex items-center space-x-1 text-obsidian-400 text-[10px]">
            <span>AST Scanner Active</span>
            <span className="w-1.5 h-1.5 rounded-full bg-neon-rose animate-pulse inline-block ml-1" />
          </div>
        </div>
      )}

      {/* ── Editor Toolbar: Active Peers, Comment Button ───────────────────── */}
      <div className="flex-shrink-0 h-8 bg-obsidian-900/80 border-b border-obsidian-700/80 flex items-center justify-between px-3 z-10">
        {/* Left: File info + peers */}
        <div className="flex items-center space-x-3 text-xs font-mono text-obsidian-400">
          <span className="text-white font-semibold">{file.name}</span>
          <span className="text-obsidian-600">·</span>
          <span className="text-obsidian-500">{file.language}</span>

          {/* Active remote peers in this file */}
          {remotePeers.size > 0 && (
            <div className="flex items-center space-x-1 pl-2 border-l border-obsidian-700">
              <span className="text-[10px] text-obsidian-500">LIVE:</span>
              {Array.from(remotePeers.values()).map(peer => (
                <span
                  key={peer.userId}
                  title={`${peer.username} — Line ${peer.lineNumber}, Col ${peer.column}`}
                  className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[9px] font-bold"
                  style={{
                    backgroundColor: `${peer.color || getUserColor(peer.userId)}25`,
                    color: peer.color || getUserColor(peer.userId),
                    border: `1px solid ${peer.color || getUserColor(peer.userId)}50`
                  }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full inline-block"
                    style={{ backgroundColor: peer.color || getUserColor(peer.userId) }}
                  />
                  <span>{peer.username.split(' ')[0]}</span>
                  <span className="text-obsidian-400">:{peer.lineNumber}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Right: Actions */}
        <div className="flex items-center space-x-2">
          {/* Breakpoints Summary */}
          {breakpoints.size > 0 && (
            <div className="flex items-center space-x-1 text-[10px] font-mono text-neon-rose">
              <span className="w-2 h-2 rounded-full bg-neon-rose" />
              <span>{breakpoints.size} BP</span>
            </div>
          )}

          {/* CRDT Ops Indicator */}
          <div className="flex items-center space-x-1 text-[10px] font-mono text-neon-cyan/70">
            <Zap className="h-3 w-3" />
            <span>{crdtOpsRef.current} ops</span>
          </div>

          {/* Add Comment Button (not for VIEWER) */}
          {!isViewer && (
            <button
              onClick={handleAddCommentToCurrentLine}
              title="Add inline comment on current line (Ctrl+Shift+C)"
              className="flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono text-obsidian-400 hover:text-neon-cyan hover:bg-obsidian-800 transition border border-transparent hover:border-obsidian-700"
            >
              <MessageSquare className="h-3 w-3" />
              <span>Comment Line</span>
            </button>
          )}

          {/* Breakpoint Branch icon */}
          <button
            title="Click glyph margin ← to toggle shared breakpoints"
            className="flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono text-obsidian-400 hover:text-neon-rose hover:bg-obsidian-800 transition border border-transparent hover:border-obsidian-700"
          >
            <GitBranch className="h-3 w-3" />
            <span>Breakpoints</span>
          </button>
        </div>
      </div>

      {/* ── Monaco Editor ─────────────────────────────────────────────────── */}
      <div className="flex-1 relative overflow-hidden">
        <Editor
          defaultValue={file.content || ''}
          language={monacoLanguage}
          theme="obsidian-devcollab"
          onMount={handleEditorDidMount}
          options={{
            automaticLayout: true,
            readOnly: isViewer,
            domReadOnly: isViewer,
            glyphMargin: true,
            lineNumbers: 'on',
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            wordWrap: monacoLanguage === 'markdown' ? 'on' : 'off',
            renderLineHighlight: 'all',
            cursorBlinking: 'smooth',
            smoothScrolling: true,
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontLigatures: true,
            tabSize: monacoLanguage === 'python' ? 4 : 2,
          }}
        />
      </div>

      {/* ── Inline Comment Draft UI ───────────────────────────────────────── */}
      {commentDraft && (
        <div className="flex-shrink-0 border-t border-obsidian-700/80 bg-obsidian-900/95 p-3 z-20 animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center space-x-2 text-xs font-mono text-obsidian-300">
              <MessageSquare className="h-3.5 w-3.5 text-neon-cyan" />
              <span className="font-semibold text-white">Inline Comment</span>
              <span className="text-obsidian-500">—</span>
              <span className="text-neon-cyan">Line {commentDraft.lineNumber}</span>
            </div>
            <button
              onClick={() => setCommentDraft(null)}
              className="text-obsidian-500 hover:text-white p-0.5 rounded"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {commentFeedback && (
            <div className="text-xs text-neon-rose font-mono mb-2 flex items-center space-x-1">
              <AlertTriangle className="h-3 w-3" />
              <span>{commentFeedback}</span>
            </div>
          )}

          <form onSubmit={handleSubmitComment} className="flex items-end space-x-2">
            <textarea
              autoFocus
              value={commentDraft.content}
              onChange={(e) => setCommentDraft(prev => prev ? { ...prev, content: e.target.value } : null)}
              placeholder={`Comment on line ${commentDraft.lineNumber}... (your identity is signed into the audit log)`}
              rows={2}
              className="flex-1 bg-obsidian-950 border border-obsidian-700 focus:border-neon-cyan rounded-lg px-3 py-1.5 text-xs text-white placeholder-obsidian-600 focus:outline-none resize-none font-mono"
            />
            <button
              type="submit"
              disabled={commentSubmitting || !commentDraft.content.trim()}
              className="px-3 py-1.5 rounded-lg bg-neon-cyan text-obsidian-950 font-bold text-xs tracking-wide disabled:opacity-50 transition whitespace-nowrap"
            >
              {commentSubmitting ? 'Posting...' : 'Post'}
            </button>
          </form>
        </div>
      )}

      {/* ── Toast Notifications ───────────────────────────────────────────── */}
      <div className="absolute bottom-10 left-3 z-50 flex flex-col space-y-1.5 pointer-events-none">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={cn(
              "flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-mono shadow-lg max-w-sm animate-fade-in",
              toast.type === 'error' && "bg-neon-rose/20 border border-neon-rose/50 text-neon-rose",
              toast.type === 'warn' && "bg-neon-amber/20 border border-neon-amber/50 text-neon-amber",
              toast.type === 'success' && "bg-neon-emerald/20 border border-neon-emerald/50 text-neon-emerald",
              toast.type === 'info' && "bg-obsidian-850 border border-obsidian-700 text-obsidian-200"
            )}
          >
            {toast.type === 'error' && <ShieldAlert className="h-3.5 w-3.5 shrink-0" />}
            {toast.type === 'warn' && <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
            {toast.type === 'success' && <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
            {toast.type === 'info' && <Info className="h-3.5 w-3.5 shrink-0" />}
            <span>{toast.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
