/**
 * D26-P2-05 — Event bus completeness (ADR D-S-13).
 *
 * Done bar: broken-promise vs socket inventory with **executed** tests.
 *
 * Not a docs tip-bump. These cases run EVENT_BUS_MATRIX (every catalog key
 * listed live | socket | broken_promise), exercise MemoryEventBus for Class A
 * (publish without a subscriber) and Class B (handler receives when mounted
 * on the test bus — proving the defect is service mount, not schema), and
 * spawn `event-wiring` so the gate's Class A/B/C line matches the inventory.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { EVENT_CATALOG, WIRING_SOCKETS, wiringSocketReason, type EventName, type PayloadOf } from './catalog.js';
import { MemoryEventBus } from './memory-bus.js';
import {
  EVENT_BUS_MATRIX,
  brokenPromiseKeys,
  buildBusCompletenessInventory,
  catalogDispositionOf,
  countByCatalogKind,
  countByClass,
  dispositionOf,
  liveEventKeys,
  socketKeys,
} from './socket-inventory.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

/** Same 12-hex pin shape as `tooling/ci/event-wiring.mjs`. */
function reasonFingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

function minimalFixtures(): Partial<{ [K in EventName]: PayloadOf<K> }> {
  const uid = () => crypto.randomUUID();
  const ts = () => new Date().toISOString();
  return {
    userCreated: { userId: uid(), handle: 'sovereign' },
    ledgerTxPosted: {
      txId: uid(),
      module: 'trade',
      reason: 'trade.fill',
      hash: 'h1',
      previousHash: null,
      entries: [
        { accountId: uid(), assetId: 'USDT', direction: 'debit', amount: '10.00' },
        { accountId: uid(), assetId: 'USDT', direction: 'credit', amount: '10.00' },
      ],
      postedAt: ts(),
    },
    crewMemberCreated: {
      crewId: uid(),
      userId: uid(),
      role: 'anchor',
      crewSize: 2,
      matchRunId: uid(),
    },
    orderAccepted: { orderId: uid(), marketId: 'btc-usdt', sequence: 1 },
    xpEarned: { userId: uid(), sourceModule: 'trade', action: 'order.filled', xpDelta: 1 },
    bankMarginCalled: {
      loanId: uid(),
      userId: uid(),
      sequence: 1,
      ltvBps: 8000,
      cureCollateralAmount: '0.1',
      collateralAssetId: 'BTC',
      calledAt: ts(),
      graceExpiresAt: ts(),
    },
  };
}

describe('D26-P2-05 bus completeness inventory (ADR D-S-13)', () => {
  const inventory = buildBusCompletenessInventory();

  it('covers every catalog event on both ends — no silent orphans', () => {
    const catalogNames = Object.keys(EVENT_CATALOG) as EventName[];
    expect(inventory.events).toEqual(catalogNames);
    expect(inventory.ends).toHaveLength(catalogNames.length * 2);

    for (const event of catalogNames) {
      const pub = inventory.ends.find((r) => r.event === event && r.end === 'publisher');
      const sub = inventory.ends.find((r) => r.event === event && r.end === 'subscriber');
      expect(pub, `${event} publisher row`).toBeDefined();
      expect(sub, `${event} subscriber row`).toBeDefined();
    }
  });

  it('partitions every end into live | socket (A|C) | broken_promise (B)', () => {
    for (const row of inventory.ends) {
      const kinds = ['live', 'socket', 'broken_promise'] as const;
      expect(kinds).toContain(row.disposition.kind);
      if (row.disposition.kind === 'broken_promise') {
        expect(row.disposition.socketClass).toBe('B');
        expect(row.disposition.socket.class).toBe('B');
      }
      if (row.disposition.kind === 'socket') {
        expect(['A', 'C']).toContain(row.disposition.socketClass);
      }
    }
  });

  it('treats Class B as broken_promise and A/C as sockets — the ADR cut', () => {
    for (const socket of WIRING_SOCKETS) {
      const d = dispositionOf(socket);
      if (socket.class === 'B') {
        expect(d.kind).toBe('broken_promise');
      } else {
        expect(d.kind).toBe('socket');
      }
    }
  });

  it('records exactly the pinned Class B broken promise — crewMemberCreated subscriber', () => {
    expect(brokenPromiseKeys(inventory)).toEqual(['crewMemberCreated::subscriber']);
    expect(inventory.brokenPromises).toHaveLength(1);
    expect(inventory.brokenPromises[0]!.event).toBe('crewMemberCreated');
    expect(inventory.brokenPromises[0]!.missing).toBe('subscriber');
    expect(inventory.brokenPromises[0]!.class).toBe('B');
    // Fingerprint matches CLASS_B_AWAITING_A_DECISION in event-wiring.mjs
    expect(reasonFingerprint(inventory.brokenPromises[0]!.reason.trim())).toBe('c020418427c6');
  });

  it('keeps Class A sockets as the true-socket inventory (not broken promises)', () => {
    const counts = countByClass(inventory);
    expect(counts.B).toBe(1);
    expect(counts.C).toBe(0);
    expect(counts.A).toBe(inventory.sockets.length);
    expect(counts.A + counts.B + counts.C).toBe(WIRING_SOCKETS.length);

    for (const key of socketKeys(inventory)) {
      expect(key).not.toMatch(/crewMemberCreated/);
    }
    // Sample of ADR Class A names — record ahead of reader
    for (const event of ['userCreated', 'ledgerTxPosted', 'orderAccepted', 'ledgerReconciliationFailed'] as const) {
      expect(socketKeys(inventory)).toContain(`${event}::subscriber`);
    }
    expect(socketKeys(inventory)).toContain('buybackExecuted::publisher');
    expect(socketKeys(inventory)).toContain('buybackExecuted::subscriber');
  });

  it('no longer inventories the two closed findings as sockets or broken promises', () => {
    expect(wiringSocketReason('xpEarned', 'subscriber')).toBeNull();
    expect(wiringSocketReason('bankMarginCalled', 'publisher')).toBeNull();
    expect(wiringSocketReason('agentActionRejected', 'subscriber')).toBeNull();
    expect(wiringSocketReason('agentActionCompleted', 'subscriber')).toBeNull();
    expect(inventory.presumedFullyWired).toContain('xpEarned');
    expect(inventory.presumedFullyWired).toContain('bankMarginCalled');
    expect(inventory.presumedFullyWired).toContain('agentActionRejected');
    expect(inventory.presumedFullyWired).toContain('agentActionCompleted');

    const closed = inventory.ends.filter(
      (r) =>
        r.event === 'xpEarned' || r.event === 'bankMarginCalled' || r.event === 'agentActionRejected' || r.event === 'agentActionCompleted',
    );
    expect(closed.every((r) => r.disposition.kind === 'live')).toBe(true);
  });

  it('every WIRING_SOCKETS entry appears exactly once on the inventory ends', () => {
    const socketEndKeys = inventory.ends
      .filter((r) => r.disposition.kind !== 'live')
      .map((r) => `${r.event}::${r.end}`)
      .sort();
    const declared = WIRING_SOCKETS.map((s) => `${s.event}::${s.missing}`).sort();
    expect(socketEndKeys).toEqual(declared);
  });

  it('lists every catalog key in EVENT_BUS_MATRIX — a new event cannot go unlisted', () => {
    const catalogNames = Object.keys(EVENT_CATALOG).sort();
    const matrixNames = Object.keys(EVENT_BUS_MATRIX).sort();
    expect(matrixNames).toEqual(catalogNames);
    expect(inventory.catalog.map((r) => r.event)).toEqual(Object.keys(EVENT_CATALOG));
  });

  it('classifies every catalog key live | socket | broken_promise and the three sets are a partition', () => {
    const kinds = countByCatalogKind(inventory);
    expect(kinds.live + kinds.socket + kinds.broken_promise).toBe(inventory.events.length);
    expect(kinds.live).toBe(inventory.live.length);
    expect(kinds.socket).toBe(inventory.socketEvents.length);
    expect(kinds.broken_promise).toBe(inventory.brokenPromiseEvents.length);

    const seen = new Set<string>();
    for (const row of inventory.catalog) {
      expect(['live', 'socket', 'broken_promise']).toContain(row.disposition.kind);
      expect(seen.has(row.event), `duplicate matrix row ${row.event}`).toBe(false);
      seen.add(row.event);
      expect(catalogDispositionOf(row.event).kind).toBe(row.disposition.kind);
    }
    expect(seen.size).toBe(inventory.events.length);
  });

  it('does not treat a recorded socket (or Class B) as live', () => {
    for (const socket of WIRING_SOCKETS) {
      const kind = catalogDispositionOf(socket.event).kind;
      expect(kind, `${socket.event} is on WIRING_SOCKETS but matrix says live`).not.toBe('live');
      expect(liveEventKeys(inventory)).not.toContain(socket.event);
      if (socket.class === 'B') {
        expect(kind).toBe('broken_promise');
        expect(inventory.brokenPromiseEvents).toContain(socket.event);
      } else {
        expect(kind).toBe('socket');
        expect(inventory.socketEvents).toContain(socket.event);
      }
    }
  });

  it('keeps matrix live keys equal to catalog keys with no WIRING_SOCKETS row', () => {
    const fromSockets = inventory.events.filter((event) => !WIRING_SOCKETS.some((s) => s.event === event));
    expect([...inventory.live].sort()).toEqual([...fromSockets].sort());
    expect(inventory.presumedFullyWired).toEqual(inventory.live);
  });
});

describe('D26-P2-05 executed MemoryEventBus behaviour', () => {
  const fixtures = minimalFixtures();

  it('Class A socket: publish succeeds with no subscriber (record ahead of its reader)', async () => {
    const bus = new MemoryEventBus('svc-identity');
    const payload = fixtures.userCreated!;
    const env = await bus.publish('userCreated', payload, { idempotencyKey: 'd26-p2-05-a' });
    expect(env.subject).toBe(EVENT_CATALOG.userCreated.subject);
    expect(bus.emitted('userCreated')).toHaveLength(1);
    // No handler attached — that is the Class A shape: durable record, nothing owed.
    await bus.close();
  });

  it('Class A money event: publish without subscriber retains the envelope', async () => {
    const bus = new MemoryEventBus('svc-ledger');
    await bus.publish('ledgerTxPosted', fixtures.ledgerTxPosted!, { idempotencyKey: 'd26-p2-05-ledger' });
    expect(bus.emitted('ledgerTxPosted')).toHaveLength(1);
    await bus.close();
  });

  it('Class B broken promise: when a subscriber IS mounted, delivery works — defect is mount, not schema', async () => {
    const bus = new MemoryEventBus('svc-academy');
    const handler = vi.fn();
    await bus.subscribe('crewMemberCreated', handler, { durable: 'academy-lobby-test' });
    await bus.publish('crewMemberCreated', fixtures.crewMemberCreated!, {
      idempotencyKey: 'd26-p2-05-crew',
    });
    expect(handler).toHaveBeenCalledTimes(1);
    // Inventory still classifies the production gap as broken_promise
    expect(brokenPromiseKeys()).toEqual(['crewMemberCreated::subscriber']);
    await bus.close();
  });

  it('closed Class B findings remain deliverable end-to-end on the test bus', async () => {
    const bus = new MemoryEventBus('svc-identity');
    const xp = vi.fn();
    await bus.subscribe('xpEarned', xp, { durable: 'rank-recalc-test' });
    await bus.publish('xpEarned', fixtures.xpEarned!, { idempotencyKey: 'd26-p2-05-xp' });
    expect(xp).toHaveBeenCalledTimes(1);

    const notify = new MemoryEventBus('svc-notify');
    const margin = vi.fn();
    await notify.subscribe('bankMarginCalled', margin, { durable: 'notify-bank-margin-test' });
    await notify.publish('bankMarginCalled', fixtures.bankMarginCalled!, {
      idempotencyKey: 'd26-p2-05-margin',
    });
    expect(margin).toHaveBeenCalledTimes(1);

    await bus.close();
    await notify.close();
  });
});

describe('D26-P2-05 event-wiring gate concordance (executed)', () => {
  // Vitest's default 5s test budget is below CI contention for this spawn —
  // spawnSync already allows 120s; the it() budget must match or the gate is
  // killed mid-run (false red, not a concordance failure).
  it('spawns event-wiring and matches Class A/B/C counts from the inventory', () => {
    const gate = join(repoRoot, 'tooling', 'ci', 'event-wiring.mjs');
    expect(existsSync(gate), `missing gate at ${gate}`).toBe(true);

    const result = spawnSync(process.execPath, [gate], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: process.env,
    });

    const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status, stdout).toBe(0);

    const inventory = buildBusCompletenessInventory();
    const counts = countByClass(inventory);

    // Gate clean line: "… recorded socket(s), each with a written reason and a class (A N · B M · C P)"
    const classLine = stdout.match(/class\s*\(\s*A\s+(\d+)\s*·\s*B\s+(\d+)\s*·\s*C\s+(\d+)\s*\)/i);
    expect(classLine, `gate did not report class counts:\n${stdout}`).not.toBeNull();
    expect(Number(classLine![1])).toBe(counts.A);
    expect(Number(classLine![2])).toBe(counts.B);
    expect(Number(classLine![3])).toBe(counts.C);

    expect(stdout).toMatch(/crewMemberCreated/);
    expect(stdout).toMatch(/Class B/i);
  }, 120_000);
});
