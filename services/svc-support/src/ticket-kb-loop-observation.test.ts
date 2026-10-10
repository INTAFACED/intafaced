/**
 * Honesty pin — ticket+KB loop is not observed in a live compose env.
 *
 * Proven in unit tests + migrations. Compose `svc-support` health is the
 * generic `/health` liveness alias, not a ticket create + KB search probe.
 * `/ready` must refuse to claim the loop was observed live.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TICKET_KB_LOOP_OBSERVED_IN_LIVE_COMPOSE,
  createTicketKbLoopObserver,
  ticketKbLoopObservedInLiveCompose,
} from './ticket-kb-loop-observation.js';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');
const HTTP_APP = resolve(import.meta.dirname, 'http-app.ts');

function supportServiceBlock(source: string): string {
  const match = source.match(/^  svc-support:\n(?:.*\n)*?(?=^  [a-z]|(?![\s\S]))/m);
  if (!match) throw new Error('svc-support service block missing from docker-compose.apps.yml');
  return match[0];
}

describe('ticket+KB loop is not observed in a live compose env', () => {
  it('pins the honesty constant: not compose-observed by default', () => {
    expect(TICKET_KB_LOOP_OBSERVED_IN_LIVE_COMPOSE).toBe(false);
    expect(ticketKbLoopObservedInLiveCompose({ TICKET_KB_LOOP_OBSERVED_IN_LIVE_COMPOSE: 'true' })).toBe(true);
  });

  it('compose declares svc-support with a generic healthcheck, not a ticket+KB probe', () => {
    const block = supportServiceBlock(readFileSync(COMPOSE, 'utf8'));
    expect(block).toMatch(/SERVICE_NAME:\s*svc-support/);
    expect(block).toMatch(/healthcheck:\s*\*healthcheck/);
    expect(block).not.toMatch(/searchKb|createTicket|getKb/);
  });

  it('returns the svc-support block when that block is last in the file', () => {
    const block = [
      '  svc-support:',
      '    environment:',
      '      SERVICE_NAME: svc-support',
      '    healthcheck: *healthcheck',
      '',
    ].join('\n');
    const source = `services:\n  svc-edge:\n    image: edge\n${block}`;
    expect(supportServiceBlock(source)).toBe(block);
  });

  it('stops before a later service and keeps a line that starts with Z', () => {
    const block = [
      '  svc-support:',
      '    environment:',
      '      SERVICE_NAME: svc-support',
      'Z not a service key',
      '    healthcheck: *healthcheck',
      '',
    ].join('\n');
    const source = `${block}  svc-market:\n    image: market\n`;
    expect(supportServiceBlock(source)).toBe(block);
  });

  it('/ready refuses to claim a live compose ticket+KB observation', () => {
    expect(TICKET_KB_LOOP_OBSERVED_IN_LIVE_COMPOSE).toBe(false);
    const src = readFileSync(HTTP_APP, 'utf8');
    expect(src).toMatch(/ticketKbLoopObservedInLiveCompose:\s*ticketKbLoopObservedInLiveCompose\(\)/);
  });

  it('process observer starts at zeros and only advances on mark', () => {
    const loop = createTicketKbLoopObserver();
    expect(loop.snapshot()).toEqual({
      lastTicketCreateAtMs: 0,
      lastKbSearchAtMs: 0,
      lastKbGetAtMs: 0,
    });
    const before = Date.now();
    loop.markTicketCreateSuccess();
    loop.markKbSearchSuccess();
    loop.markKbGetSuccess();
    const snap = loop.snapshot();
    expect(snap.lastTicketCreateAtMs).toBeGreaterThanOrEqual(before);
    expect(snap.lastKbSearchAtMs).toBeGreaterThanOrEqual(before);
    expect(snap.lastKbGetAtMs).toBeGreaterThanOrEqual(before);
  });
});
