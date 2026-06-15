/**
 * Canonical list of Claude models selectable in Codedeck.
 *
 * Single source of truth for the Settings model dropdown, the per-session model
 * picker in InputBar, and the model badge. Model IDs are the full strings the
 * Claude API / Agent SDK accept (see https://platform.claude.com/docs/en/about-claude/models/overview).
 *
 * `label` is the compact tag shown on the InputBar button + badges.
 * `name` is the full human-readable name shown in dropdowns/menus.
 * Order is newest/most-capable first.
 */
export interface ModelInfo {
  id: string;
  /** Compact label for the InputBar button + badges, e.g. 'O4.8'. */
  label: string;
  /** Full display name, e.g. 'Claude Opus 4.8'. */
  name: string;
}

export const MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-8', label: 'O4.8', name: 'Claude Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'O4.7', name: 'Claude Opus 4.7' },
  { id: 'claude-sonnet-4-6', label: 'S4.6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'H4.5', name: 'Claude Haiku 4.5' },
  { id: 'claude-fable-5', label: 'F5', name: 'Claude Fable 5' },
];

/** Default model for new sessions and fresh installs. */
export const DEFAULT_MODEL = 'claude-opus-4-8';

/** Compact label for a model ID — falls back to a trimmed ID for unknown models. */
export function modelLabel(id: string | undefined): string {
  if (!id) return '?';
  const found = MODELS.find((m) => m.id === id);
  if (found) return found.label;
  // Unknown/custom model: strip the 'claude-' prefix and any date suffix for a usable tag.
  return id.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/** Full display name for a model ID — falls back to the raw ID for unknown models. */
export function modelName(id: string | undefined): string {
  if (!id) return 'Default';
  return MODELS.find((m) => m.id === id)?.name ?? id;
}
