import { useEffect, useState, useCallback, useRef, useMemo, CSSProperties } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { List, useListRef, useDynamicRowHeight } from 'react-window';
import { useSessionStore } from '../stores/sessionStore';
import { OutputEntry } from '../types';
import {
  useDisplayEntries,
  DisplayEntry,
  ToolGroupDisplay,
  PlanApprovalDisplay,
  QuestionDisplay,
  QuestionGroupDisplay,
  PermissionRequestDisplay,
} from '../hooks/useDisplayEntries';
import '../styles/output.css';

const EMPTY_OUTPUTS: OutputEntry[] = [];
const DEFAULT_ROW_HEIGHT = 40;

// --- Entry-level components ---

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

function UserMessageBubble({ entry }: { entry: OutputEntry }) {
  const imageFilename = entry.metadata?.imageFilename as string | undefined;
  return (
    <div className="user-message-row">
      <div className="user-message-bubble">
        <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>{entry.content}</Markdown>
        {imageFilename && (
          <div className="user-message-image-tag">
            <span className="user-message-image-icon">&#x1F4CE;</span>
            {imageFilename.length > 28 ? imageFilename.slice(0, 25) + '...' : imageFilename}
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantMessage({ entry }: { entry: OutputEntry }) {
  return (
    <div className="assistant-message">
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>{entry.content}</Markdown>
    </div>
  );
}

function ToolGroupEntry({
  item,
  expanded,
  onToggle,
}: {
  item: ToolGroupDisplay;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="tool-group">
      <button className="tool-group-header" onClick={onToggle} aria-expanded={expanded}>
        <span className={`tool-group-chevron${expanded ? ' tool-group-chevron-open' : ''}`}>
          &#x25B8;
        </span>
        <span className="tool-group-summary">{item.summary}</span>
      </button>
      {expanded && (
        <div className="tool-group-body">
          {item.entries.map((entry, i) => (
            <div key={i} className="tool-group-item">
              {entry.metadata?.special === 'device_screenshot' && entry.metadata?.imageDataUri ? (
                <DeviceScreenshot entry={entry} />
              ) : (
                entry.content
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Inline render of a device screenshot delivered by a test session (Phase 3). */
function DeviceScreenshot({ entry }: { entry: OutputEntry }) {
  const uri = entry.metadata?.imageDataUri as string | undefined;
  if (!uri) return <>{entry.content}</>;
  return (
    <div className="device-screenshot">
      <img
        src={uri}
        alt={entry.content || 'device screenshot'}
        style={{ maxWidth: '100%', borderRadius: 6, display: 'block' }}
      />
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{entry.content}</div>
    </div>
  );
}

function DiffEntry({ entry }: { entry: OutputEntry }) {
  const lines = entry.content.split('\n');
  return (
    <div className="output-diff">
      {entry.metadata?.filename ? (
        <div className="output-diff-filename">{String(entry.metadata.filename)}</div>
      ) : null}
      {lines.map((line, i) => {
        const isAdd = line.startsWith('+');
        const isRemove = line.startsWith('-');
        const cls = isRemove ? 'output-diff-remove' : isAdd ? 'output-diff-add' : '';
        return <div key={i} className={cls}>{line}</div>;
      })}
    </div>
  );
}

function ErrorEntry({ entry }: { entry: OutputEntry }) {
  return <div className="output-error">{entry.content}</div>;
}

function SystemEntry({ entry }: { entry: OutputEntry }) {
  if (!entry.content) return null;
  return <div className="output-system">{entry.content}</div>;
}

const PLAN_APPROVAL_LABELS: Record<string, string> = {
  '1': 'Plan approved — Accept Edits',
  '2': 'Plan approved — YOLO',
  '3': 'Plan revised',
};

function PlanApprovalEntry({ sessionId, answered, cardId, hasPlan }: { sessionId: string; answered?: string; cardId?: string; hasPlan?: boolean }) {
  const sendKeypress = useSessionStore((s) => s.sendRemoteKeypress);
  const markResponded = useSessionStore((s) => s.markCardResponded);
  const setPendingRevision = useSessionStore((s) => s.setPendingRevision);
  const setModeLocal = useSessionStore((s) => s.setRemoteSessionModeLocal);
  const setPlanApprovalChoice = useSessionStore((s) => s.setPlanApprovalChoice);
  const storedChoice = useSessionStore((s) => cardId ? s.planApprovalChoices.get(cardId) : undefined);
  const responded = useSessionStore((s) => cardId ? s.isCardResponded(sessionId, cardId) : false);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  if (answered) {
    const label = storedChoice ? PLAN_APPROVAL_LABELS[storedChoice] : answered;
    return (
      <div className="plan-approval-bar plan-approval-answered">
        <div className="plan-approval-label">{label}</div>
      </div>
    );
  }
  if (responded) {
    const choice = selectedOption || storedChoice;
    const label = choice === '3' ? 'Type your revision below'
      : choice ? PLAN_APPROVAL_LABELS[choice]
      : 'Response sent...';
    return (
      <div className="plan-approval-bar plan-approval-answered">
        <div className="plan-approval-label">{label}</div>
      </div>
    );
  }

  // No plan: simple "Exit plan mode?" yes/no
  if (hasPlan === false) {
    const respond = (key: string) => {
      setSelectedOption(key);
      if (cardId) markResponded(sessionId, cardId);
      sendKeypress(sessionId, key, 'exit-plan');
      if (key === '1') {
        setModeLocal(sessionId, 'default');
      }
    };
    return (
      <div className="plan-approval-bar">
        <div className="plan-approval-label">Exit plan mode?</div>
        <div className="plan-approval-actions plan-approval-options">
          <button className="plan-option-btn plan-option-primary" onClick={() => respond('1')}>
            <span className="plan-option-label">Yes</span>
            <span className="plan-option-desc">Exit plan mode and start coding</span>
          </button>
          <button className="plan-option-btn plan-option-secondary" onClick={() => respond('2')}>
            <span className="plan-option-label">No</span>
            <span className="plan-option-desc">Stay in plan mode</span>
          </button>
        </div>
      </div>
    );
  }

  // With plan: full 3-option approval
  const respond = (key: string) => {
    setSelectedOption(key);
    if (cardId) {
      markResponded(sessionId, cardId);
      setPlanApprovalChoice(cardId, key);
    }
    sendKeypress(sessionId, key, 'plan-approval');
    if (key === '1') {
      setModeLocal(sessionId, 'acceptEdits');
    } else if (key === '2') {
      setModeLocal(sessionId, 'default');
    } else if (key === '3') {
      setPendingRevision(sessionId);
    }
  };
  return (
    <div className="plan-approval-bar">
      <div className="plan-approval-label">Approve this plan?</div>
      <div className="plan-approval-actions plan-approval-options">
        <button className="plan-option-btn plan-option-primary" onClick={() => respond('1')}>
          <span className="plan-option-label">Approve — mode EDITS</span>
          <span className="plan-option-desc">Auto-accepts file edits, prompts for Bash/Web</span>
        </button>
        <button className="plan-option-btn plan-option-primary" onClick={() => respond('2')}>
          <span className="plan-option-label">Approve — mode YOLO (default)</span>
          <span className="plan-option-desc">Auto-approves all tool actions</span>
        </button>
        <button className="plan-option-btn plan-option-secondary" onClick={() => respond('3')}>
          <span className="plan-option-label">Revise plan</span>
          <span className="plan-option-desc">Type feedback to change the plan</span>
        </button>
      </div>
    </div>
  );
}


/** Heuristic: detect "type your own answer" style options.
 *  High-confidence phrases match at any position;
 *  lower-confidence keywords still require last position. */
function isFreeTextOption(label: string, index: number, total: number): boolean {
  if (total < 3) return false;
  const lower = label.toLowerCase();
  // High-confidence: unambiguous free-text phrases — match anywhere
  if (/\b(something else|your own|type something|type your )\b/.test(lower)) return true;
  // Lower-confidence: only trust at last position
  const isLast = index === total - 1;
  return isLast && /\b(provide|write |specify|custom|other)\b/.test(lower);
}

function QuestionEntry({ item, sessionId }: { item: QuestionDisplay; sessionId: string }) {
  const sendKeypress = useSessionStore((s) => s.sendRemoteKeypress);
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const markResponded = useSessionStore((s) => s.markCardResponded);
  const clearPendingQuestion = useSessionStore((s) => s.clearPendingQuestion);
  const cardId = item.entry.metadata?.tool_use_id as string | undefined;
  const responded = useSessionStore((s) => cardId ? s.isCardResponded(sessionId, cardId) : false);
  const [showTextInput, setShowTextInput] = useState(false);
  const [textValue, setTextValue] = useState('');
  const [sending, setSending] = useState(false);
  const textInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus when text input appears
  useEffect(() => {
    if (showTextInput && textInputRef.current) {
      textInputRef.current.focus();
    }
  }, [showTextInput]);

  if (item.answered) {
    return (
      <div className="question-card question-answered">
        {item.header && <div className="question-header">{item.header}</div>}
        <div className="question-text">{item.entry.content}</div>
        <div className="question-answer">{item.answered}</div>
      </div>
    );
  }
  if (responded && !showTextInput) {
    return (
      <div className="question-card question-answered">
        {item.header && <div className="question-header">{item.header}</div>}
        <div className="question-text">{item.entry.content}</div>
        <div className="question-answer">Response sent...</div>
      </div>
    );
  }

  const hasOptions = item.options && item.options.length > 0;
  // Find which option (if any) is the "type your own" variant
  const freeTextOptionIndex = hasOptions
    ? item.options!.findIndex((opt, i) => isFreeTextOption(opt.label, i, item.options!.length))
    : -1;

  const handleTextSubmit = async () => {
    const trimmed = textValue.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      // If we selected a free-text option, the keypress was already sent.
      // Now send the actual typed text as regular input.
      if (cardId) markResponded(sessionId, cardId);
      await sendMessage(sessionId, trimmed);
      setShowTextInput(false);
    } finally {
      setSending(false);
    }
  };

  const textInput = (
    <div className="question-text-input">
      <input
        ref={textInputRef}
        type="text"
        className="question-input-field"
        placeholder="Type your answer..."
        value={textValue}
        onChange={(e) => setTextValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleTextSubmit(); }}
        disabled={sending}
        autoFocus={!hasOptions}
      />
      <button
        className="question-input-submit"
        onClick={handleTextSubmit}
        disabled={!textValue.trim() || sending}
      >
        {sending ? '...' : 'Send'}
      </button>
    </div>
  );

  // No options or already selected the free-text option → show text input
  if (!hasOptions || showTextInput) {
    return (
      <div className="question-card">
        {item.header && <div className="question-header">{item.header}</div>}
        <div className="question-text">{item.entry.content}</div>
        {textInput}
      </div>
    );
  }

  return (
    <div className="question-card">
      {item.header && <div className="question-header">{item.header}</div>}
      <div className="question-text">{item.entry.content}</div>
      <div className="question-options">
        {item.options!.map((opt, i) => (
          <button
            key={i}
            className="question-option-btn"
            onClick={() => {
              if (freeTextOptionIndex === i) {
                // Just show text input — the typed text goes through question-input path
                // with parent_tool_use_id set by the bridge's sendQuestionInput()
                setShowTextInput(true);
              } else {
                clearPendingQuestion(sessionId);
                if (cardId) markResponded(sessionId, cardId);
                sendKeypress(sessionId, String(i + 1), 'question');
              }
            }}
          >
            <span className="question-option-label">{opt.label}</span>
            {opt.description && (
              <span className="question-option-desc">{opt.description}</span>
            )}
          </button>
        ))}
      </div>
      {freeTextOptionIndex === -1 && (
        <button
          className="question-type-own-btn"
          onClick={() => {
            setShowTextInput(true);
          }}
        >
          Type your own answer...
        </button>
      )}
    </div>
  );
}

function QuestionGroupEntry({ item, sessionId }: { item: QuestionGroupDisplay; sessionId: string }) {
  const sendKeypress = useSessionStore((s) => s.sendRemoteKeypress);
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const markResponded = useSessionStore((s) => s.markCardResponded);
  const isCardResponded = useSessionStore((s) => s.isCardResponded);
  const clearPendingQuestion = useSessionStore((s) => s.clearPendingQuestion);

  // Per-question response tracking uses composite card IDs: "toolUseId:q0", "toolUseId:q1", etc.
  const { toolUseId, questions } = item;

  // Determine which questions are already answered (from store, survives re-renders)
  const answeredSet = new Set<number>();
  for (let i = 0; i < questions.length; i++) {
    if (isCardResponded(sessionId, `${toolUseId}:q${i}`)) {
      answeredSet.add(i);
    }
  }

  // Active tab = first unanswered question
  const firstUnanswered = questions.findIndex((_, i) => !answeredSet.has(i));
  const allAnswered = firstUnanswered === -1;
  const [activeTab, setActiveTab] = useState(() => allAnswered ? 0 : firstUnanswered);

  // Per-question text input state
  const [showTextInput, setShowTextInput] = useState(false);
  const [textValue, setTextValue] = useState('');
  const [sending, setSending] = useState(false);
  const textInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showTextInput && textInputRef.current) {
      textInputRef.current.focus();
    }
  }, [showTextInput]);

  // Auto-advance activeTab when a question gets answered
  useEffect(() => {
    if (!allAnswered && activeTab !== firstUnanswered) {
      setActiveTab(firstUnanswered);
      setShowTextInput(false);
      setTextValue('');
    }
  }, [firstUnanswered, allAnswered]); // eslint-disable-line react-hooks/exhaustive-deps

  // Completed state (from bridge tool_result)
  if (item.answered) {
    return (
      <div className="question-card question-answered">
        <div className="question-tabs">
          {questions.map((q, i) => (
            <div key={i} className="question-tab question-tab-done">
              {q.header ?? `Question ${i + 1}`}
            </div>
          ))}
        </div>
        <div className="question-answer">{item.answered}</div>
      </div>
    );
  }

  // All answered locally
  if (allAnswered) {
    return (
      <div className="question-card question-answered">
        <div className="question-tabs">
          {questions.map((q, i) => (
            <div key={i} className="question-tab question-tab-done">
              {q.header ?? `Question ${i + 1}`}
            </div>
          ))}
        </div>
        <div className="question-answer">All responses sent</div>
      </div>
    );
  }

  const activeQuestion = questions[activeTab];
  const hasOptions = activeQuestion.options && activeQuestion.options.length > 0;
  const freeTextOptionIndex = hasOptions
    ? activeQuestion.options!.findIndex((opt, i) => isFreeTextOption(opt.label, i, activeQuestion.options!.length))
    : -1;

  const handleAnswer = (optionIndex: number) => {
    if (freeTextOptionIndex === optionIndex) {
      setShowTextInput(true);
    } else {
      clearPendingQuestion(sessionId);
      markResponded(sessionId, `${toolUseId}:q${activeTab}`);
      sendKeypress(sessionId, String(optionIndex + 1), 'question');
    }
  };

  const handleTextSubmit = async () => {
    const trimmed = textValue.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      markResponded(sessionId, `${toolUseId}:q${activeTab}`);
      await sendMessage(sessionId, trimmed);
      setShowTextInput(false);
      setTextValue('');
    } finally {
      setSending(false);
    }
  };

  const textInput = (
    <div className="question-text-input">
      <input
        ref={textInputRef}
        type="text"
        className="question-input-field"
        placeholder="Type your answer..."
        value={textValue}
        onChange={(e) => setTextValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleTextSubmit(); }}
        disabled={sending}
        autoFocus={!hasOptions}
      />
      <button
        className="question-input-submit"
        onClick={handleTextSubmit}
        disabled={!textValue.trim() || sending}
      >
        {sending ? '...' : 'Send'}
      </button>
    </div>
  );

  return (
    <div className="question-card">
      <div className="question-tabs">
        {questions.map((q, i) => {
          const isDone = answeredSet.has(i);
          const isActive = i === activeTab;
          const isFuture = i > firstUnanswered;
          let cls = 'question-tab';
          if (isActive) cls += ' question-tab-active';
          else if (isDone) cls += ' question-tab-done';
          else if (isFuture) cls += ' question-tab-disabled';
          return (
            <button
              key={i}
              className={cls}
              disabled={isFuture || isDone}
              onClick={() => { if (!isFuture && !isDone) setActiveTab(i); }}
            >
              {isDone && <span className="question-tab-check">&#x2713; </span>}
              {q.header ?? `Question ${i + 1}`}
            </button>
          );
        })}
      </div>
      <div className="question-text">{activeQuestion.entry.content}</div>
      {(!hasOptions || showTextInput) ? (
        textInput
      ) : (
        <>
          <div className="question-options">
            {activeQuestion.options!.map((opt, i) => (
              <button key={i} className="question-option-btn" onClick={() => handleAnswer(i)}>
                <span className="question-option-label">{opt.label}</span>
                {opt.description && (
                  <span className="question-option-desc">{opt.description}</span>
                )}
              </button>
            ))}
          </div>
          {freeTextOptionIndex === -1 && (
            <button
              className="question-type-own-btn"
              onClick={() => {
                setShowTextInput(true);
              }}
            >
              Type your own answer...
            </button>
          )}
        </>
      )}
    </div>
  );
}

function PermissionRequestEntry({ item, sessionId }: { item: PermissionRequestDisplay; sessionId: string }) {
  const respondRemotePermission = useSessionStore((s) => s.respondRemotePermission);
  const markResponded = useSessionStore((s) => s.markCardResponded);
  const responded = useSessionStore((s) => s.isCardResponded(sessionId, item.requestId));

  if (responded) {
    return (
      <div className="permission-request-card permission-request-answered">
        <div className="plan-approval-label">{item.toolName}</div>
        <div className="output-system" style={{ margin: '4px 0 8px' }}>{item.description}</div>
        <div className="plan-approval-label">Response sent...</div>
      </div>
    );
  }

  // Tool-specific "always" label: WebFetch/WebSearch use per-domain allowlists
  const isWebTool = item.toolName === 'WebFetch' || item.toolName === 'WebSearch';
  const alwaysLabel = isWebTool ? 'Allow domain' : 'Always';

  const respond = (allow: boolean, modifier?: 'always' | 'never') => {
    markResponded(sessionId, item.requestId);
    respondRemotePermission(sessionId, item.requestId, allow, modifier);
  };
  return (
    <div className="permission-request-card" aria-live="polite">
      <div className="plan-approval-label">{item.toolName}</div>
      <div className="output-system" style={{ margin: '4px 0 8px' }}>{item.description}</div>
      <div className="plan-approval-actions">
        <button className="btn-allow" onClick={() => respond(true)}>Allow</button>
        <button className="btn-always" onClick={() => respond(true, 'always')}>{alwaysLabel}</button>
        <button className="btn-deny" onClick={() => respond(false)}>Deny</button>
      </div>
    </div>
  );
}

// --- Display item dispatcher ---

function DisplayItem({
  item,
  expanded,
  onToggle,
  sessionId,
}: {
  item: DisplayEntry;
  expanded: boolean;
  onToggle: () => void;
  sessionId: string;
}) {
  switch (item.kind) {
    case 'user_message':
      return <UserMessageBubble entry={item.entry} />;
    case 'assistant_message':
      return <AssistantMessage entry={item.entry} />;
    case 'tool_group':
      return <ToolGroupEntry item={item} expanded={expanded} onToggle={onToggle} />;
    case 'error':
      return <ErrorEntry entry={item.entry} />;
    case 'system':
      return <SystemEntry entry={item.entry} />;
    case 'diff':
      return <DiffEntry entry={item.entry} />;
    case 'plan_approval':
      return <PlanApprovalEntry sessionId={sessionId} answered={(item as PlanApprovalDisplay).answered} cardId={(item as PlanApprovalDisplay).entry.metadata?.tool_use_id as string | undefined} hasPlan={(item as PlanApprovalDisplay).entry.metadata?.has_plan !== false} />;
    case 'question':
      return <QuestionEntry item={item} sessionId={sessionId} />;
    case 'question_group':
      return <QuestionGroupEntry item={item} sessionId={sessionId} />;
    case 'permission_request':
      return <PermissionRequestEntry item={item} sessionId={sessionId} />;
    default:
      return null;
  }
}

// --- Row component for react-window ---

interface RowProps {
  display: DisplayEntry[];
  isExpanded: (sourceStart: number) => boolean;
  toggleGroup: (sourceStart: number) => void;
  sessionId: string;
}

function OutputRow({
  index,
  style,
  display,
  isExpanded,
  toggleGroup,
  sessionId,
}: {
  index: number;
  style: CSSProperties;
  ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' };
  display: DisplayEntry[];
  isExpanded: (sourceStart: number) => boolean;
  toggleGroup: (sourceStart: number) => void;
  sessionId: string;
}) {
  const item = display[index];
  const expanded = item.kind === 'tool_group' ? isExpanded(item.sourceStart) : false;
  const onToggle = useCallback(() => toggleGroup(item.sourceStart), [toggleGroup, item.sourceStart]);

  return (
    <div style={style}>
      <DisplayItem item={item} expanded={expanded} onToggle={onToggle} sessionId={sessionId} />
    </div>
  );
}

// --- Main component ---

export default function OutputStream({ sessionId }: { sessionId: string }) {
  const outputs = useSessionStore((s) => s.outputs[sessionId] ?? EMPTY_OUTPUTS);
  const isLoading = useSessionStore((s) => !!s.historyLoading[sessionId]);
  const { display, toggleGroup, isExpanded } = useDisplayEntries(outputs);
  // Hide the gray per-turn metadata system lines — token counts, the
  // "Session complete — N turns, $cost" summary, and the "Claude Code x.y.z"
  // banner. They accumulate between agent output and are pure visual clutter.
  const filteredDisplay = useMemo(() => {
    return display.filter((item) => {
      if (item.kind !== 'system') return true;
      const t = item.entry.content;
      return !t.startsWith('Claude Code')
        && !t.startsWith('Session complete')
        && !t.startsWith('Tokens:');
    });
  }, [display]);

  const listRef = useListRef(null);
  const dynamicHeight = useDynamicRowHeight({ defaultRowHeight: DEFAULT_ROW_HEIGHT });
  const [autoScroll, setAutoScroll] = useState(true);
  const [showPill, setShowPill] = useState(false);
  const [prevCount, setPrevCount] = useState(0);
  const autoScrollRef = useRef(true);
  const displayLenRef = useRef(0);

  // Keep refs in sync so the ResizeObserver callback reads fresh values
  autoScrollRef.current = autoScroll;
  displayLenRef.current = filteredDisplay.length;

  // Guarded scroll-to-end: always reads displayLenRef at call time to avoid stale indices
  const safeScrollToEnd = useCallback(() => {
    const len = displayLenRef.current;
    if (listRef.current && len > 0) {
      listRef.current.scrollToRow({ index: len - 1, align: 'end' });
    }
  }, [listRef]);

  // Reset scroll state on session switch — ensures new sessions open at the bottom
  useEffect(() => {
    setAutoScroll(true);
    autoScrollRef.current = true;
    setShowPill(false);
    setPrevCount(0);

    const t1 = setTimeout(safeScrollToEnd, 50);
    const t2 = setTimeout(safeScrollToEnd, 300);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show "New output" pill when new entries arrive while user is scrolled away
  useEffect(() => {
    if (filteredDisplay.length > prevCount) {
      if (!autoScroll) {
        setShowPill(true);
      }
      setPrevCount(filteredDisplay.length);
    }
  }, [filteredDisplay.length, autoScroll, prevCount]);

  // Direct auto-scroll on new entries — reliable cross-platform fallback
  useEffect(() => {
    if (autoScrollRef.current && filteredDisplay.length > 0) {
      safeScrollToEnd();
      const timer = setTimeout(safeScrollToEnd, 80);
      return () => clearTimeout(timer);
    }
  }, [filteredDisplay.length, safeScrollToEnd]);

  // Auto-scroll whenever the inner content grows (new entries, streaming, expand, etc.)
  useEffect(() => {
    const el = listRef.current?.element;
    if (!el) return;
    const inner = el.firstElementChild;
    if (!inner) return;
    const observer = new ResizeObserver(() => {
      if (autoScrollRef.current) safeScrollToEnd();
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [listRef]);

  // Scroll to bottom on initial load (fix for history sessions)
  useEffect(() => {
    if (filteredDisplay.length > 0 && prevCount === 0) {
      // Small delay to let react-window measure row heights
      const timer = setTimeout(safeScrollToEnd, 100);
      return () => clearTimeout(timer);
    }
  }, [filteredDisplay.length, prevCount, listRef]);

  // On container resize (orientation change, keyboard), re-scroll if auto-scroll is on
  const handleResize = useCallback((_size: { height: number; width: number }) => {
    if (autoScrollRef.current) safeScrollToEnd();
  }, [safeScrollToEnd]);

  const scrollToBottom = useCallback(() => {
    safeScrollToEnd();
    setAutoScroll(true);
    setShowPill(false);
  }, [safeScrollToEnd]);

  // Track scroll position to detect manual scroll-away
  const handleNativeScroll = useCallback(() => {
    const el = listRef.current?.element;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const atBottom = scrollHeight - scrollTop - clientHeight < 150;
    setAutoScroll(atBottom);
    if (atBottom) setShowPill(false);
  }, [listRef]);

  // Attach native scroll listener to the list's outer element
  useEffect(() => {
    const el = listRef.current?.element;
    if (!el) return;
    el.addEventListener('scroll', handleNativeScroll);
    return () => el.removeEventListener('scroll', handleNativeScroll);
  }, [listRef, handleNativeScroll]);

  const rowProps: RowProps = { display: filteredDisplay, isExpanded, toggleGroup, sessionId };

  return (
    <div className="output-container" role="log" aria-label="Session output">
      {filteredDisplay.length === 0 ? (
        <div className="output-scroll">
          <div className={`output-empty${isLoading ? ' loading' : ''}`}>
            {isLoading ? 'Loading session history...' : 'Send a message to start the agent'}
          </div>
        </div>
      ) : (
        <List<RowProps>
          listRef={listRef}
          className="output-virtual-list"
          rowCount={filteredDisplay.length}
          rowHeight={dynamicHeight}
          rowComponent={OutputRow}
          rowProps={rowProps}
          overscanCount={10}
          onResize={handleResize}
          style={{ height: '100%' }}
        />
      )}
      {showPill && (
        <button className="output-new-pill" onClick={scrollToBottom}>
          New output
        </button>
      )}
    </div>
  );
}
