import { describe, expect, it } from 'vitest';
import {
  PACKET_PREFIX,
  confirmPhrase,
  decodePacket,
  describeRequest,
  encodePacket,
  packetExpired,
  readDeskRequest,
  requestReason,
  validReason,
  type ApprovalPacket,
  type DeskRequest,
} from './approval-packet';

const kill: DeskRequest = { kind: 'edge.kill', module: 'trade', disabled: true, reason: 'market integrity incident — halt new risk' };
const packet: ApprovalPacket = {
  request: kill,
  approvalId: 'appr_01HZX',
  operationId: 'op_01HZX',
  expiresAt: '2026-10-17T03:10:00.000Z',
  requesterId: '11111111-1111-4111-8111-111111111111',
};

describe('request packets', () => {
  it('round-trip exactly, including non-ASCII reasons', () => {
    const unicode: ApprovalPacket = { ...packet, request: { ...kill, reason: 'Incident Δ — réconciliation échouée ✓' } };
    for (const p of [packet, unicode]) {
      const read = decodePacket(encodePacket(p));
      expect(read).toEqual({ ok: true, packet: p });
    }
  });

  it('carries every request kind', () => {
    for (const request of [
      kill,
      { kind: 'edge.kill', module: 'pay', disabled: false, reason: 'cause resolved, reconciled' },
      { kind: 'ledger.freeze', reason: 'reconciliation mismatch on USD', version: '2026-10-17 03:00:00.123456+00' },
      { kind: 'ledger.unfreeze', version: '2026-10-17 03:00:00.123456+00' },
    ] as const) {
      expect(decodePacket(encodePacket({ ...packet, request }))).toEqual({ ok: true, packet: { ...packet, request } });
    }
  });

  it('ignore whitespace around the packet and nothing else', () => {
    const text = encodePacket(packet);
    expect(decodePacket(`  \n${text}\n `).ok).toBe(true);
    expect(decodePacket(`${text} extra`).ok).toBe(false);
    expect(decodePacket(`x${text}`).ok).toBe(false);
  });

  it('refuse empty, non-packets and damaged packets, with the reason', () => {
    expect(decodePacket('')).toEqual({ ok: false, reason: 'empty' });
    expect(decodePacket('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(decodePacket('hello')).toEqual({ ok: false, reason: 'not_a_packet' });
    expect(decodePacket(`${PACKET_PREFIX}@@@`)).toEqual({ ok: false, reason: 'damaged' });
    expect(decodePacket(`${PACKET_PREFIX}${'A'.repeat(7000)}`)).toEqual({ ok: false, reason: 'not_a_packet' });
    const text = encodePacket(packet);
    // Flip a character in the middle: it either stops being a packet or reads as a DIFFERENT packet. The hash an
    // approver recomputes from what they read is what stops a different request being approved (approval-hash.test.ts).
    const middle = Math.floor(text.length / 2);
    const damaged = text.slice(0, middle) + (text[middle] === 'A' ? 'B' : 'A') + text.slice(middle + 1);
    const read = decodePacket(damaged);
    if (read.ok) expect(read.packet).not.toEqual(packet);
  });

  it('refuse extra or missing fields, unknown kinds, unknown modules and bad ids', () => {
    const wrap = (value: unknown) => PACKET_PREFIX + Buffer.from(JSON.stringify(value)).toString('base64url');
    expect(decodePacket(wrap({ ...packet, extra: 1 })).ok).toBe(false);
    const { requesterId: _r, ...missing } = packet;
    expect(decodePacket(wrap(missing)).ok).toBe(false);
    expect(decodePacket(wrap({ ...packet, request: { ...kill, kind: 'edge.unknown' } })).ok).toBe(false);
    expect(decodePacket(wrap({ ...packet, request: { ...kill, module: 'not-a-module' } })).ok).toBe(false);
    expect(decodePacket(wrap({ ...packet, request: { ...kill, extra: true } })).ok).toBe(false);
    expect(decodePacket(wrap({ ...packet, approvalId: 'has space' })).ok).toBe(false);
    expect(decodePacket(wrap({ ...packet, approvalId: '' })).ok).toBe(false);
    expect(decodePacket(wrap({ ...packet, expiresAt: 'tomorrow-ish' })).ok).toBe(false);
    expect(decodePacket(wrap({ ...packet, request: { ...kill, reason: 'short' } })).ok).toBe(false);
  });
});

describe('request reading is strict', () => {
  it('only accepts reasons that are already trimmed and 12 to 500 characters', () => {
    expect(validReason('twelve chars')).toBe(true);
    expect(validReason('eleven char')).toBe(false);
    expect(validReason(' padded reason ok ')).toBe(false);
    expect(validReason('x'.repeat(500))).toBe(true);
    expect(validReason('x'.repeat(501))).toBe(false);
    expect(validReason(12)).toBe(false);
  });
  it('rejects a kill with a non-boolean flag and a freeze without a version', () => {
    expect(readDeskRequest({ kind: 'edge.kill', module: 'trade', disabled: 'true', reason: 'twelve chars' })).toBeNull();
    expect(readDeskRequest({ kind: 'ledger.freeze', reason: 'twelve chars' })).toBeNull();
    expect(readDeskRequest({ kind: 'ledger.unfreeze', version: '' })).toBeNull();
    expect(readDeskRequest(null)).toBeNull();
    expect(readDeskRequest([])).toBeNull();
  });
});

describe('what the founder is asked to type and read', () => {
  it('the phrase names the action and the module', () => {
    expect(confirmPhrase(kill)).toBe('KILL trade');
    expect(confirmPhrase({ ...kill, disabled: false })).toBe('RE-ENABLE trade');
    expect(confirmPhrase({ kind: 'ledger.freeze', reason: 'twelve chars', version: 'v' })).toBe('FREEZE LEDGER');
    expect(confirmPhrase({ kind: 'ledger.unfreeze', version: 'v' })).toBe('UNFREEZE LEDGER');
  });
  it('the description says what will happen in plain words', () => {
    expect(describeRequest(kill)).toContain('Kill module "trade"');
    expect(describeRequest({ ...kill, disabled: false })).toContain('Re-enable module "trade"');
    expect(describeRequest({ kind: 'ledger.freeze', reason: 'twelve chars', version: 'v' })).toContain('ALL value movement');
  });
  it('the reason is shown for kills and freezes and absent for an unfreeze', () => {
    expect(requestReason(kill)).toBe(kill.reason);
    expect(requestReason({ kind: 'ledger.unfreeze', version: 'v' })).toBeNull();
  });
  it('expiry is advisory but is compared against the supplied clock', () => {
    expect(packetExpired(packet, new Date('2026-10-17T03:09:59.000Z'))).toBe(false);
    expect(packetExpired(packet, new Date('2026-10-17T03:10:00.000Z'))).toBe(true);
  });
});

describe('market and academy requests', () => {
  const vendorId = '5a3b9c10-1111-4222-8333-444455556666';
  const userId = '9f8e7d6c-1111-4222-8333-444455556666';
  const vet = { kind: 'market.vendor.vet', vendorId, decision: 'approved', reason: 'documents checked against the application' } as const;
  const freeze = { kind: 'academy.ambassador.freeze', userId, reason: 'conduct complaint under review' } as const;
  const unfreeze = { kind: 'academy.ambassador.unfreeze', userId } as const;

  it('round-trip as packets', () => {
    for (const request of [vet, freeze, unfreeze]) {
      expect(decodePacket(encodePacket({ ...packet, request }))).toEqual({ ok: true, packet: { ...packet, request } });
    }
  });

  it('are read strictly: ids must be UUIDs, decisions known, no extra keys, reasons long enough', () => {
    expect(readDeskRequest({ ...vet, vendorId: 'not-a-uuid' })).toBeNull();
    expect(readDeskRequest({ ...vet, decision: 'delisted' })).toBeNull();
    expect(readDeskRequest({ ...vet, reason: 'short' })).toBeNull();
    expect(readDeskRequest({ ...vet, extra: 1 })).toBeNull();
    expect(readDeskRequest({ ...freeze, userId: '1234' })).toBeNull();
    expect(readDeskRequest({ ...unfreeze, reason: 'not part of an unfreeze' })).toBeNull();
    expect(readDeskRequest(vet)).toEqual(vet);
  });

  it('phrases name the verb and the first eight characters of the id', () => {
    expect(confirmPhrase(vet)).toBe('APPROVE VENDOR 5a3b9c10');
    expect(confirmPhrase({ ...vet, decision: 'rejected' })).toBe('REJECT VENDOR 5a3b9c10');
    expect(confirmPhrase({ ...vet, decision: 'suspended' })).toBe('SUSPEND VENDOR 5a3b9c10');
    expect(confirmPhrase(freeze)).toBe('FREEZE AMBASSADOR 9f8e7d6c');
    expect(confirmPhrase(unfreeze)).toBe('UNFREEZE AMBASSADOR 9f8e7d6c');
  });

  it('are described with the full id, and an unfreeze has no reason', () => {
    expect(describeRequest(vet)).toContain(vendorId);
    expect(describeRequest(freeze)).toContain(userId);
    expect(requestReason(vet)).toBe(vet.reason);
    expect(requestReason(freeze)).toBe(freeze.reason);
    expect(requestReason(unfreeze)).toBeNull();
  });
});
