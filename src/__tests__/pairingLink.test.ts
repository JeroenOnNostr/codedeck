import { describe, it, expect, beforeEach } from 'vitest';
import * as nip19 from 'nostr-tools/nip19';
import { extractPairingUrl, applyPairingLink } from '../services/pairingLink';
import { useSessionStore } from '../stores/sessionStore';
import { useDmStore } from '../stores/dmStore';

const BRIDGE_HEX = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
const BRIDGE_NPUB = nip19.npubEncode(BRIDGE_HEX);

function link(params: Record<string, string> = {}): string {
  const qs = new URLSearchParams({
    npub: BRIDGE_NPUB,
    relays: 'wss%3A%2F%2Frelay.primal.net',
    machine: 'My Laptop',
    ...params,
  });
  return `codedeck://pair?${qs.toString()}`;
}

describe('extractPairingUrl', () => {
  it('returns a bare link unchanged', () => {
    const url = link();
    expect(extractPairingUrl(url)).toBe(url);
  });

  it('finds a link buried in chat-app prose', () => {
    const url = link();
    expect(extractPairingUrl(`Here you go: ${url}`)).toBe(url);
    expect(extractPairingUrl(`${url}\n\n— sent from my laptop`)).toBe(url);
  });

  it('strips sentence punctuation glued onto the end', () => {
    const url = link();
    expect(extractPairingUrl(`Paste this: ${url}.`)).toBe(url);
    expect(extractPairingUrl(`(${url})`)).toBe(url);
  });

  it('returns null when there is no link', () => {
    expect(extractPairingUrl('hello')).toBeNull();
    expect(extractPairingUrl('')).toBeNull();
    expect(extractPairingUrl('https://example.com/pair')).toBeNull();
  });
});

describe('applyPairingLink', () => {
  beforeEach(() => {
    useSessionStore.setState({ machines: [], pairToast: null });
    useDmStore.setState({
      nostrConfig: { ...useDmStore.getState().nostrConfig, private_key_hex: null },
    });
  });

  it('rejects a non-Codedeck URL', () => {
    const result = applyPairingLink('https://example.com/pair?npub=x');
    expect(result).toEqual({ ok: false, error: 'Not a Codedeck pairing link.' });
    expect(useSessionStore.getState().machines).toHaveLength(0);
  });

  it('rejects unparseable text', () => {
    const result = applyPairingLink('codedeck://');
    expect(result.ok).toBe(false);
  });

  it('rejects a link with no npub', () => {
    const result = applyPairingLink('codedeck://pair?machine=Laptop');
    expect(result).toEqual({ ok: false, error: 'This link is missing a valid bridge npub.' });
  });

  it('rejects a link whose npub is malformed', () => {
    const result = applyPairingLink('codedeck://pair?npub=npub1notarealkey');
    expect(result).toEqual({ ok: false, error: 'This link is missing a valid bridge npub.' });
  });

  it('registers the machine from a valid link', () => {
    const result = applyPairingLink(link());
    expect(result.ok).toBe(true);

    const machines = useSessionStore.getState().machines;
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({
      hostname: 'My Laptop',
      npub: BRIDGE_NPUB,
      pubkeyHex: BRIDGE_HEX,
      relays: ['wss://relay.primal.net'],
      connected: false,
    });
  });

  it('reports that a tokenless link cannot pair', () => {
    const result = applyPairingLink(link());
    expect(result).toMatchObject({ ok: true, pairRequestSent: false });
    if (result.ok) expect(result.note).toMatch(/no pairing token/i);
  });

  it('reports that a keyless phone cannot pair even with a token', () => {
    const result = applyPairingLink(link({ token: 'deadbeef' }));
    expect(result).toMatchObject({ ok: true, pairRequestSent: false });
    if (result.ok) expect(result.note).toMatch(/no Nostr key/i);
  });

  it('sends the pair-request when both a token and a key are present', () => {
    useDmStore.setState({
      nostrConfig: { ...useDmStore.getState().nostrConfig, private_key_hex: BRIDGE_HEX },
    });

    const result = applyPairingLink(link({ token: 'deadbeef' }));
    expect(result).toMatchObject({ ok: true, pairRequestSent: true });
  });

  it('merges the link\'s relays into the DM config', () => {
    useDmStore.setState({
      nostrConfig: { ...useDmStore.getState().nostrConfig, relays: ['wss://nos.lol'] },
    });

    applyPairingLink(link());
    expect(useDmStore.getState().nostrConfig.relays).toContain('wss://relay.primal.net');
    expect(useDmStore.getState().nostrConfig.relays).toContain('wss://nos.lol');
  });
});
