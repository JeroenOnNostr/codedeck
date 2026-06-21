import { useMemo, useState, useCallback } from 'react';
import { OutputEntry } from '../types';
import { useSessionStore } from '../stores/sessionStore';

export interface DisplayEntryBase {
  /** Original index range in the source array, used for stable keys */
  sourceStart: number;
}

export interface UserMessageDisplay extends DisplayEntryBase {
  kind: 'user_message';
  entry: OutputEntry;
}

export interface AssistantMessageDisplay extends DisplayEntryBase {
  kind: 'assistant_message';
  entry: OutputEntry;
}

export interface ToolGroupDisplay extends DisplayEntryBase {
  kind: 'tool_group';
  entries: OutputEntry[];
  summary: string;
}

export interface ErrorDisplay extends DisplayEntryBase {
  kind: 'error';
  entry: OutputEntry;
}

export interface SystemDisplay extends DisplayEntryBase {
  kind: 'system';
  entry: OutputEntry;
}

export interface DiffDisplay extends DisplayEntryBase {
  kind: 'diff';
  entry: OutputEntry;
}

export interface PlanApprovalDisplay extends DisplayEntryBase {
  kind: 'plan_approval';
  entry: OutputEntry;
  answered?: string;
}

export interface QuestionDisplay extends DisplayEntryBase {
  kind: 'question';
  entry: OutputEntry;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  /** True when the user may pick multiple options (sent as a comma-joined answer). */
  multiSelect?: boolean;
  answered?: string;
}

export interface QuestionGroupQuestion {
  entry: OutputEntry;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface QuestionGroupDisplay extends DisplayEntryBase {
  kind: 'question_group';
  toolUseId: string;
  questions: QuestionGroupQuestion[];
  answered?: string;
}

export interface PermissionRequestDisplay extends DisplayEntryBase {
  kind: 'permission_request';
  entry: OutputEntry;
  toolName: string;
  description: string;
  requestId: string;
  /** True when the request originates from a sub-agent (Bridge sets metadata.subagent). */
  isSubAgent?: boolean;
  /** Best-effort sub-agent type label (e.g. 'Plan'), from Bridge metadata.agent_label. */
  agentLabel?: string;
}

export type DisplayEntry =
  | UserMessageDisplay
  | AssistantMessageDisplay
  | ToolGroupDisplay
  | ErrorDisplay
  | SystemDisplay
  | DiffDisplay
  | PlanApprovalDisplay
  | QuestionDisplay
  | QuestionGroupDisplay
  | PermissionRequestDisplay;

const TOOL_ENTRY_TYPES = new Set(['tool_use', 'tool_result', 'action']);

function isToolEntry(entry: OutputEntry): boolean {
  return TOOL_ENTRY_TYPES.has(entry.entry_type);
}

/** Check if an assistant text entry should be collapsed into a tool group.
 *  Uses `display_hint` from the bridge (set based on whether the SDK message
 *  also contained tool_use blocks). Falls back to 'show' for old bridge versions. */
function shouldCollapseText(entry: OutputEntry): boolean {
  if (entry.metadata?.special) return false;
  if (entry.entry_type !== 'message' && entry.entry_type !== 'text') return false;
  if (entry.metadata?.role === 'user') return false;
  return entry.metadata?.display_hint === 'collapse';
}

/** Build a summary string for a group of tool entries, e.g. "3 actions" */
function buildToolSummary(entries: OutputEntry[]): string {
  const count = entries.filter(e => isToolEntry(e)).length;
  return `${count} action${count !== 1 ? 's' : ''}`;
}

/**
 * Collect tool_use_ids that have a matching tool_result response,
 * mapping each to the answer content text.
 */
function collectAnsweredToolUseIds(outputs: OutputEntry[]): Map<string, string> {
  const answered = new Map<string, string>();
  for (const entry of outputs) {
    if (entry.entry_type === 'tool_result') {
      const id = entry.metadata?.tool_use_id as string | undefined;
      if (id) answered.set(id, entry.content);
    }
  }
  return answered;
}

/**
 * Transforms a flat OutputEntry[] into grouped DisplayEntry[].
 * - Consecutive tool entries are merged into tool_group items
 * - Answered plan_approval / ask_question entries shown in completed state
 * - Answered permission_request entries are omitted (bridge pre-filters for history)
 * - token_usage entries are handled upstream in the store (never reach here)
 */
function buildDisplayEntries(outputs: OutputEntry[]): DisplayEntry[] {
  const display: DisplayEntry[] = [];
  let currentToolGroup: OutputEntry[] = [];
  let toolGroupStart = 0;
  const answeredMap = collectAnsweredToolUseIds(outputs);
  // Question group buffering (groups consecutive ask_question entries with same tool_use_id)
  let pendingQuestions: QuestionGroupQuestion[] = [];
  let pendingQuestionToolUseId: string | null = null;
  let pendingQuestionStart = 0;

  function flushToolGroup() {
    if (currentToolGroup.length > 0) {
      display.push({
        kind: 'tool_group',
        entries: currentToolGroup,
        summary: buildToolSummary(currentToolGroup),
        sourceStart: toolGroupStart,
      });
      currentToolGroup = [];
    }
  }

  function flushQuestionGroup() {
    if (pendingQuestions.length === 0) return;
    const toolUseId = pendingQuestionToolUseId!;
    const answerContent = answeredMap.get(toolUseId);
    // Check metadata for expected question count (bridge v0.3.4+ includes question_index/question_count)
    const expectedCount = pendingQuestions[0].entry.metadata?.question_count as number | undefined;
    const isMulti = expectedCount != null ? expectedCount > 1 : pendingQuestions.length > 1;
    if (!isMulti) {
      // Single question — emit as regular QuestionDisplay (no tabs needed)
      const q = pendingQuestions[0];
      display.push({
        kind: 'question',
        entry: q.entry,
        header: q.header,
        options: q.options,
        multiSelect: q.multiSelect,
        sourceStart: pendingQuestionStart,
        answered: answerContent,
      });
    } else {
      // Sort by question_index if available (robust against out-of-order delivery)
      pendingQuestions.sort((a, b) => {
        const ai = (a.entry.metadata?.question_index as number) ?? 0;
        const bi = (b.entry.metadata?.question_index as number) ?? 0;
        return ai - bi;
      });
      display.push({
        kind: 'question_group',
        toolUseId,
        questions: pendingQuestions,
        sourceStart: pendingQuestionStart,
        answered: answerContent,
      });
    }
    pendingQuestions = [];
    pendingQuestionToolUseId = null;
  }

  for (let i = 0; i < outputs.length; i++) {
    const entry = outputs[i];

    // Group consecutive tool entries
    if (isToolEntry(entry)) {
      flushQuestionGroup();
      if (currentToolGroup.length === 0) {
        toolGroupStart = i;
      }
      currentToolGroup.push(entry);
      continue;
    }

    // Assistant text with display_hint: 'collapse' → absorb into tool group
    if (shouldCollapseText(entry)) {
      if (currentToolGroup.length === 0) toolGroupStart = i;
      currentToolGroup.push(entry);
      continue;
    }
    flushToolGroup();

    const special = entry.metadata?.special as string | undefined;
    const toolUseId = entry.metadata?.tool_use_id as string | undefined;

    // Buffer consecutive ask_question entries with same tool_use_id
    if (special === 'ask_question') {
      if (pendingQuestionToolUseId && toolUseId !== pendingQuestionToolUseId) {
        flushQuestionGroup();
      }
      if (pendingQuestions.length === 0) {
        pendingQuestionStart = i;
        pendingQuestionToolUseId = toolUseId ?? null;
      }
      pendingQuestions.push({
        entry,
        header: entry.metadata?.header as string | undefined,
        options: entry.metadata?.options as Array<{ label: string; description?: string }> | undefined,
        multiSelect: entry.metadata?.multiSelect as boolean | undefined,
      });
      continue;
    }

    // Non-question entry — flush any pending question group
    flushQuestionGroup();

    // Skip answered permission_request entries (bridge pre-filters these for history)
    if (special === 'permission_request' && toolUseId && answeredMap.has(toolUseId)) {
      continue;
    }

    // Plan text entry (emitted by bridge before plan_approval with same tool_use_id).
    // Always show as readable text — the plan stays visible after approval.
    if (special === 'plan') {
      display.push({ kind: 'assistant_message', entry, sourceStart: i });
      continue;
    }

    if (special === 'plan_approval') {
      // Use short label instead of raw tool_result content for answered state
      const isAnswered = toolUseId ? answeredMap.has(toolUseId) : false;
      display.push({ kind: 'plan_approval', entry, sourceStart: i, answered: isAnswered ? 'Plan approved' : undefined });
      continue;
    }
    if (special === 'permission_request') {
      display.push({
        kind: 'permission_request',
        entry,
        toolName: (entry.metadata?.tool_name as string) ?? '',
        description: entry.content,
        requestId: toolUseId ?? '',
        isSubAgent: !!entry.metadata?.subagent,
        agentLabel: entry.metadata?.agent_label as string | undefined,
        sourceStart: i,
      });
      continue;
    }

    switch (entry.entry_type) {
      case 'user_message':
        display.push({ kind: 'user_message', entry, sourceStart: i });
        break;
      case 'text':
      case 'message':
        display.push({ kind: 'assistant_message', entry, sourceStart: i });
        break;
      case 'error':
        display.push({ kind: 'error', entry, sourceStart: i });
        break;
      case 'diff':
        display.push({ kind: 'diff', entry, sourceStart: i });
        break;
      case 'system':
        display.push({ kind: 'system', entry, sourceStart: i });
        break;
      default:
        display.push({ kind: 'assistant_message', entry, sourceStart: i });
    }
  }

  // Flush any trailing groups
  flushQuestionGroup();
  flushToolGroup();

  return display;
}

/** @internal Exported for testing only */
export { buildDisplayEntries as _buildDisplayEntries };

/**
 * Hook that transforms flat OutputEntry[] into grouped DisplayEntry[],
 * and manages collapse state for tool groups.
 *
 * Collapse state is keyed by `sourceStart` (stable index into the source
 * OutputEntry array) rather than display index, so expanding a group
 * survives new entries being appended to the stream.
 */
export function useDisplayEntries(outputs: OutputEntry[]) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  const display = useMemo(() => buildDisplayEntries(outputs), [outputs]);

  const toggleGroup = useCallback((sourceStart: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sourceStart)) {
        next.delete(sourceStart);
      } else {
        next.add(sourceStart);
      }
      return next;
    });
  }, []);

  const isExpanded = useCallback((sourceStart: number) => expanded.has(sourceStart), [expanded]);

  return { display, toggleGroup, isExpanded };
}

export interface PendingRemotePermission {
  requestId: string;
  toolName: string;
  description: string;
  isSubAgent: boolean;
  agentLabel?: string;
}

/**
 * Pure scan: find the latest still-pending permission request in a remote session's output stream
 * — the most recent `permission_request` entry that has neither received a tool_result (answeredMap)
 * nor been answered optimistically (respondedCards). Exported for unit testing; returns null when
 * nothing is pending.
 */
export function findPendingPermission(
  outputs: OutputEntry[] | undefined,
  respondedCards: Set<string> | undefined,
): PendingRemotePermission | null {
  if (!outputs || outputs.length === 0) return null;
  const answered = collectAnsweredToolUseIds(outputs);
  for (let i = outputs.length - 1; i >= 0; i--) {
    const entry = outputs[i];
    if (entry.metadata?.special !== 'permission_request') continue;
    const toolUseId = entry.metadata?.tool_use_id as string | undefined;
    if (!toolUseId) continue;
    if (answered.has(toolUseId) || respondedCards?.has(toolUseId)) continue;
    return {
      requestId: toolUseId,
      toolName: (entry.metadata?.tool_name as string) ?? '',
      description: entry.content,
      isSubAgent: !!entry.metadata?.subagent,
      agentLabel: entry.metadata?.agent_label as string | undefined,
    };
  }
  return null;
}

/**
 * Derive the latest still-pending permission for a remote session. Used to pin an always-visible
 * RemotePermissionBar above the input — remote sessions have no PermissionBar and the inline card
 * can be buried below a large collapsed sub-agent group (which is exactly how a permission prompt
 * goes unseen and deadlocks the session).
 */
export function usePendingRemotePermission(sessionId: string): PendingRemotePermission | null {
  const outputs = useSessionStore((s) => s.outputs[sessionId]);
  const respondedCards = useSessionStore((s) => s.respondedCards.get(sessionId));
  return useMemo(() => findPendingPermission(outputs, respondedCards), [outputs, respondedCards]);
}
