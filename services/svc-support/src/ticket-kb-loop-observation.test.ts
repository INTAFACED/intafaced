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
import { mountedSupportApp } from './testing/mounted-app.js';
import { composeServiceBlock } from '@intafaced/config/compose';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');

function supportServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-support');
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
    const block = ['  svc-support:', '    environment:', '      SERVICE_NAME: svc-support', '    healthcheck: *healthcheck', ''].join('\n');
    const source = `services:\n  svc-edge:\n    image: edge\n${block}`;
    expect(supportServiceBlock(source)).toBe(block);
  });

  it('stops before a later service and keeps a line that starts with Z', () => {
    const block = [
      '  svc-support:',
      '    environment:',
      '      SERVICE_NAME: svc-support',
      '      Z_NOT_A_SERVICE_KEY: kept',
      '    healthcheck: *healthcheck',
      '',
    ].join('\n');
    const source = `${block}  svc-market:\n    image: market\n`;
    expect(supportServiceBlock(source)).toBe(block);
  });

  it('/ready refuses to claim a live compose ticket+KB observation', async () => {
    expect(TICKET_KB_LOOP_OBSERVED_IN_LIVE_COMPOSE).toBe(false);
    const { app, get } = await mountedSupportApp(undefined);
    const ready = await get('/ready');
    expect(ready.body.ticketKbLoopObservedInLiveCompose).toBe(ticketKbLoopObservedInLiveCompose());
    expect(ready.body.ticketKbLoopObservedInLiveCompose).toBe(false);
    await app.close();
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
