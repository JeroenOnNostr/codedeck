/**
 * Profile metadata service (NIP-01 kind 0) with an outbox-ish discovery model.
 *
 * Why this exists separate from nostrService.ts:
 *   - nostrService owns the live DM gift-wrap subscription lifecycle; its pool is
 *     created/destroyed with the DM connection. Profile fetches have a different
 *     lifecycle (one-shot queries against a broader relay set) and must not be
 *     coupled to — or leak through — the DM pool.
 *
 * Strategy (the old code only queried the 3 DM relays once with a 5s timeout and
 * gave up silently — most profiles live elsewhere):
 *   Round 1 (outbox): fetch the target's NIP-65 relay list (kind 10002) from
 *     dedicated indexer/aggregator relays, then query kind 0 from the union of
 *     those write relays + the fallback aggregators.
 *   Round 2/3 (fallback): query kind 0 from the broad fallback set with a longer
 *     timeout and a small backoff.
 * Concurrent callers for the same pubkey are de-duplicated so we fire one fetch.
 */

import { SimplePool } from 'nostr-tools/pool';
import { Metadata, RelayList } from 'nostr-tools/kinds';
import type { ProfileMetadata } from '../types';
import { dmLog, dmWarn } from './debugLog';

/**
 * Indexer / aggregator relays queried FIRST to discover a pubkey's own write
 * relays (kind 10002) and as a kind-0 source. These specialize in aggregating
 * kind-0 + kind-10002 for the whole network, so they answer even when the user
 * never published directly to them.
 */
export const PROFILE_INDEXER_RELAYS = [
  'wss://purplepag.es',      // dedicated profile + relay-list aggregator
  'wss://relay.nostr.band',  // large full-archive indexer
  'wss://user.kindpag.es',   // purplepag.es sibling aggregator (redundancy)
];

/**
 * Always-included fallback set for the kind-0 fetch: the highest-traffic,
 * high-uptime general relays where most profiles end up replicated, plus the
 * aggregators (which also serve kind 0 directly).
 */
export const PROFILE_FALLBACK_RELAYS = [
  'wss://relay.damus.io',    // largest iOS client relay — most profiles mirrored
  'wss://nos.lol',           // popular general relay (also in the DM set)
  'wss://relay.primal.net',  // Primal caching relay, very broad coverage
  'wss://purplepag.es',      // aggregator also serves kind 0 directly
  'wss://relay.nostr.band',  // indexer also serves kind 0 directly
];

// Field length clamps — guard against garbage/huge kind-0 content bloating the
// persisted store.
const MAX_SHORT = 200;   // name, displayName, nip05
const MAX_ABOUT = 500;
const MAX_PICTURE = 2048;

const ROUND1_TIMEOUT_MS = 8_000;
const ROUND_TIMEOUT_MS = 10_000;
const BACKOFF_MS = 1_500;
const RELAYLIST_TIMEOUT_MS = 6_000;
const MAX_WRITE_RELAYS = 6;

/** Dedicated, long-lived pool for one-shot profile queries (no DM coupling). */
let profilePool: SimplePool | null = null;
function getPool(): SimplePool {
  if (!profilePool) profilePool = new SimplePool();
  return profilePool;
}

/** Clamp a metadata string field; reject non-strings. */
function clampStr(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

/** Accept only http(s) picture URLs of sane length (reject data: blobs). */
function sanitizePicture(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length > MAX_PICTURE) return undefined;
  if (!/^https?:\/\//i.test(value)) return undefined;
  return value;
}

/** Normalize a relay URL: trim, require ws(s)://, drop a trailing slash. */
function normalizeRelay(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!/^wss?:\/\//i.test(trimmed)) return null;
  return trimmed.replace(/\/+$/, '');
}

/** Dedup a relay list, preserving order. */
function dedupRelays(relays: string[]): string[] {
  return Array.from(new Set(relays));
}

/** Race a promise against a hard timeout that resolves to a sentinel. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

/**
 * Fetch a pubkey's NIP-65 write relays (kind 10002) from the indexer relays.
 * Returns up to MAX_WRITE_RELAYS normalized write relays, or [] on any failure.
 */
async function fetchWriteRelays(pubkeyHex: string): Promise<string[]> {
  const pool = getPool();
  try {
    const event = await withTimeout(
      pool.get(PROFILE_INDEXER_RELAYS, { kinds: [RelayList], authors: [pubkeyHex] }),
      RELAYLIST_TIMEOUT_MS,
      null,
    );
    if (!event) return [];

    const writeRelays: string[] = [];
    for (const tag of event.tags) {
      if (tag[0] !== 'r') continue;
      const url = normalizeRelay(tag[1]);
      if (!url) continue;
      // No marker = both read+write; explicit 'write' = write. Skip 'read'.
      const marker = tag[2];
      if (marker === undefined || marker === 'write') {
        writeRelays.push(url);
      }
    }
    return dedupRelays(writeRelays).slice(0, MAX_WRITE_RELAYS);
  } catch (err) {
    dmWarn('Profile', `relay-list (kind 10002) fetch failed for ${pubkeyHex.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Parse + sanitize a kind-0 event into ProfileMetadata, or null on bad content. */
function parseMetadata(content: string): ProfileMetadata | null {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(content);
  } catch {
    return null;
  }
  if (!meta || typeof meta !== 'object') return null;

  return {
    name: clampStr(meta.name, MAX_SHORT),
    displayName: clampStr(meta.display_name, MAX_SHORT),
    picture: sanitizePicture(meta.picture),
    nip05: clampStr(meta.nip05, MAX_SHORT),
    about: clampStr(meta.about, MAX_ABOUT),
    fetchedAt: Date.now(),
    status: 'ok',
  };
}

/** Query kind 0 from a relay set; return parsed metadata or null. */
async function queryKind0(pubkeyHex: string, relays: string[], timeoutMs: number): Promise<ProfileMetadata | null> {
  if (relays.length === 0) return null;
  const pool = getPool();
  const event = await withTimeout(
    pool.get(relays, { kinds: [Metadata], authors: [pubkeyHex] }),
    timeoutMs,
    null,
  );
  if (!event?.content) return null;
  return parseMetadata(event.content);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch full profile metadata for a pubkey using the outbox + retry strategy.
 * Always resolves (never rejects) — on total miss returns status:'notfound'.
 */
export async function fetchProfile(pubkeyHex: string): Promise<ProfileMetadata> {
  // Round 1 — outbox: discover write relays, query union(write, fallback).
  try {
    const writeRelays = await fetchWriteRelays(pubkeyHex);
    const round1Relays = dedupRelays([...writeRelays, ...PROFILE_FALLBACK_RELAYS]);
    dmLog('Profile', `round 1 for ${pubkeyHex.slice(0, 8)}… — write relays: [${writeRelays.join(', ') || 'none'}]`);
    const meta = await queryKind0(pubkeyHex, round1Relays, ROUND1_TIMEOUT_MS);
    if (meta) {
      dmLog('Profile', `round 1 hit for ${pubkeyHex.slice(0, 8)}… — ${meta.displayName || meta.name || '(no name)'}`);
      return meta;
    }
  } catch (err) {
    dmWarn('Profile', `round 1 error for ${pubkeyHex.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Rounds 2-3 — fallback set only, longer timeout, small backoff.
  for (let round = 2; round <= 3; round++) {
    await sleep(BACKOFF_MS);
    try {
      dmLog('Profile', `round ${round} for ${pubkeyHex.slice(0, 8)}… — fallback relays`);
      const meta = await queryKind0(pubkeyHex, PROFILE_FALLBACK_RELAYS, ROUND_TIMEOUT_MS);
      if (meta) {
        dmLog('Profile', `round ${round} hit for ${pubkeyHex.slice(0, 8)}… — ${meta.displayName || meta.name || '(no name)'}`);
        return meta;
      }
    } catch (err) {
      dmWarn('Profile', `round ${round} error for ${pubkeyHex.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dmWarn('Profile', `no kind-0 found for ${pubkeyHex.slice(0, 8)}… after 3 rounds`);
  return { fetchedAt: Date.now(), status: 'notfound' };
}

/** In-flight fetches keyed by pubkey, so concurrent callers share one fetch. */
const inFlight = new Map<string, Promise<ProfileMetadata>>();

/**
 * Like fetchProfile, but de-duplicates concurrent calls for the same pubkey.
 * N simultaneous resolveProfile(samePubkey) → exactly one network fetch.
 */
export function fetchProfileDedup(pubkeyHex: string): Promise<ProfileMetadata> {
  const existing = inFlight.get(pubkeyHex);
  if (existing) return existing;
  const p = fetchProfile(pubkeyHex).finally(() => inFlight.delete(pubkeyHex));
  inFlight.set(pubkeyHex, p);
  return p;
}
