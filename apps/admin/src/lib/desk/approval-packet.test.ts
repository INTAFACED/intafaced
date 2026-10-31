import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_REASON_CODES,
  CLOSE_REASON_CODES,
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
import { accountArchiveReasonCodes, accountCloseReasonCodes } from '@intafaced/contracts';

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
      {
        kind: 'ledger.reconciliation_control.run',
        controlId: '0b4f6c2e-1111-4222-8333-444455556666',
        version: '3',
        asOf: '2026-10-23T06:30:00.000Z',
        margin: '0',
        reason: 'LOCAL TEST run the USDT floor control',
      },
      { kind: 'academy.ambassador.appoint', userId: '9f8e7d6c-1111-4222-8333-444455556666' },
      { kind: 'academy.residency.decide', id: '5a3b9c10-1111-4222-8333-444455556666', decision: 'accepted' },
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
    expect(decodePacket(`${PACKET_PREFIX}${'A'.repeat(15_000)}`)).toEqual({ ok: false, reason: 'not_a_packet' });
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
    const run = {
      kind: 'ledger.reconciliation_control.run',
      controlId: '0b4f6c2e-1111-4222-8333-444455556666',
      version: '3',
      asOf: 'now',
      margin: 'unset',
      reason: 'LOCAL TEST run the USDT floor control',
    };
    expect(readDeskRequest(run)).toEqual(run);
    // A run now carries no margin; a past run names one; an instant is only the exact ISO text svc-ledger hashes.
    expect(readDeskRequest({ ...run, margin: '30' })).toBeNull();
    expect(readDeskRequest({ ...run, asOf: '2026-10-23T06:30:00.000Z' })).toBeNull();
    expect(readDeskRequest({ ...run, asOf: '2026-10-23T06:30:00Z', margin: '0' })).toBeNull();
    expect(readDeskRequest({ ...run, version: '0' })).toBeNull();
    expect(readDeskRequest(null)).toBeNull();
    expect(readDeskRequest([])).toBeNull();
  });
  it('reads a lifecycle move only with a known move, a whole version and nothing else', () => {
    const move = {
      kind: 'ledger.reconciliation_control.lifecycle',
      controlId: '0b4f6c2e-1111-4222-8333-444455556666',
      version: '4',
      lifecycle: 'retire',
      reason: 'LOCAL TEST retire the old USDT floor',
    };
    expect(readDeskRequest(move)).toEqual(move);
    expect(readDeskRequest({ ...move, lifecycle: 'activate' })).toBeNull();
    expect(readDeskRequest({ ...move, version: '0' })).toBeNull();
    expect(readDeskRequest({ ...move, asOf: 'now' })).toBeNull();
    expect(confirmPhrase(move as Parameters<typeof confirmPhrase>[0])).toBe('RETIRE CONTROL 0b4f6c2e');
    expect(describeRequest(move as Parameters<typeof describeRequest>[0])).toContain('never runs again');
  });
});

describe('what the founder is asked to type and read', () => {
  it('the phrase names the action and the module', () => {
    expect(confirmPhrase(kill)).toBe('KILL trade');
    expect(confirmPhrase({ ...kill, disabled: false })).toBe('RE-ENABLE trade');
    expect(confirmPhrase({ kind: 'ledger.freeze', reason: 'twelve chars', version: 'v' })).toBe('FREEZE LEDGER');
    expect(confirmPhrase({ kind: 'ledger.unfreeze', version: 'v' })).toBe('UNFREEZE LEDGER');
    expect(
      confirmPhrase({
        kind: 'ledger.reconciliation_control.run',
        controlId: '0b4f6c2e-1111-4222-8333-444455556666',
        version: '3',
        asOf: 'now',
        margin: 'unset',
        reason: 'LOCAL TEST run the USDT floor control',
      }),
    ).toBe('RUN CONTROL 0b4f6c2e');
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

describe('academy appoint and residency decision requests', () => {
  const userId = '9f8e7d6c-1111-4222-8333-444455556666';
  const id = '5a3b9c10-1111-4222-8333-444455556666';
  it('are read strictly: exact keys, uuid ids, a known decision, and no free-text note that the approval would not cover', () => {
    expect(readDeskRequest({ kind: 'academy.ambassador.appoint', userId })).toEqual({ kind: 'academy.ambassador.appoint', userId });
    expect(readDeskRequest({ kind: 'academy.ambassador.appoint', userId: 'not-a-uuid' })).toBeNull();
    expect(readDeskRequest({ kind: 'academy.ambassador.appoint', userId, reason: 'twelve chars!' })).toBeNull();
    expect(readDeskRequest({ kind: 'academy.residency.decide', id, decision: 'rejected' })).toEqual({
      kind: 'academy.residency.decide',
      id,
      decision: 'rejected',
    });
    expect(readDeskRequest({ kind: 'academy.residency.decide', id, decision: 'withdrawn' })).toBeNull();
    expect(readDeskRequest({ kind: 'academy.residency.decide', id, decision: 'accepted', note: 'looks fine to me' })).toBeNull();
    expect(readDeskRequest({ kind: 'academy.residency.decide', id: 'x', decision: 'accepted' })).toBeNull();
  });
  it('name the person or application in the phrase to type, and say in plain words what they do', () => {
    expect(confirmPhrase({ kind: 'academy.ambassador.appoint', userId })).toBe('APPOINT AMBASSADOR 9f8e7d6c');
    expect(confirmPhrase({ kind: 'academy.residency.decide', id, decision: 'accepted' })).toBe('ACCEPT RESIDENCY 5a3b9c10');
    expect(confirmPhrase({ kind: 'academy.residency.decide', id, decision: 'rejected' })).toBe('REJECT RESIDENCY 5a3b9c10');
    expect(describeRequest({ kind: 'academy.ambassador.appoint', userId })).toContain(`Appoint ${userId}`);
    expect(describeRequest({ kind: 'academy.ambassador.appoint', userId })).toContain('pays nothing');
    expect(describeRequest({ kind: 'academy.residency.decide', id, decision: 'accepted' })).toContain('recorded as accepted');
    expect(describeRequest({ kind: 'academy.residency.decide', id, decision: 'rejected' })).toContain('recorded as rejected');
  });
  it('carry no reason', () => {
    expect(requestReason({ kind: 'academy.ambassador.appoint', userId })).toBeNull();
    expect(requestReason({ kind: 'academy.residency.decide', id, decision: 'accepted' })).toBeNull();
    expect(requestReason({ kind: 'academy.ambassador.freeze', userId, reason: 'conduct complaint under review' })).toBe(
      'conduct complaint under review',
    );
  });
});

describe('card freeze and listing takedown requests', () => {
  const cardId = '9f8e7d6c-1111-4222-8333-444455556666';
  const listingId = '5a3b9c10-1111-4222-8333-444455556666';
  const freeze = { kind: 'bank.card.status', cardId, status: 'frozen', reason: 'owner reported the card stolen' } as const;
  const takedown = { kind: 'market.listing.takedown', listingId, reason: 'sells a forbidden product' } as const;
  it('round-trip as packets', () => {
    for (const request of [freeze, { ...freeze, status: 'active' }, takedown] as const) {
      expect(decodePacket(encodePacket({ ...packet, request }))).toEqual({ ok: true, packet: { ...packet, request } });
    }
  });
  it('are read strictly: uuid ids, a known status, exact keys, a trimmed reason of 12 to 500 characters', () => {
    expect(readDeskRequest(freeze)).toEqual(freeze);
    expect(readDeskRequest({ ...freeze, status: 'closed' })).toBeNull();
    expect(readDeskRequest({ ...freeze, cardId: 'card-1' })).toBeNull();
    expect(readDeskRequest({ ...freeze, reason: 'short' })).toBeNull();
    expect(readDeskRequest({ ...freeze, extra: 1 })).toBeNull();
    const { reason: _r, ...noReason } = freeze;
    expect(readDeskRequest(noReason)).toBeNull();
    expect(readDeskRequest(takedown)).toEqual(takedown);
    expect(readDeskRequest({ ...takedown, listingId: 'x' })).toBeNull();
    expect(readDeskRequest({ ...takedown, reason: ' padded reason here ' })).toBeNull();
    expect(readDeskRequest({ ...takedown, status: 'active' })).toBeNull();
  });
  it('the phrase to type names the verb and the first eight characters of the id', () => {
    expect(confirmPhrase(freeze)).toBe('FREEZE CARD 9f8e7d6c');
    expect(confirmPhrase({ ...freeze, status: 'active' })).toBe('UNFREEZE CARD 9f8e7d6c');
    expect(confirmPhrase(takedown)).toBe('TAKE DOWN LISTING 5a3b9c10');
  });
  it('says in plain words what it does, including what cannot be undone', () => {
    expect(describeRequest(freeze)).toContain(cardId);
    expect(describeRequest(freeze)).toContain('its owner cannot unfreeze it');
    const lift = describeRequest({ ...freeze, status: 'active' });
    expect(lift).toContain('Lift the freeze on card');
    expect(lift).toContain('the owner set themselves');
    expect(lift).toContain('check with the owner first');
    expect(describeRequest(takedown)).toContain('for good');
    expect(describeRequest(takedown)).toContain('nothing is refunded');
  });
  it('carry their reason', () => {
    expect(requestReason(freeze)).toBe('owner reported the card stolen');
    expect(requestReason(takedown)).toBe('sells a forbidden product');
  });
});

describe('account unfreeze requests', () => {
  const unfreeze = {
    kind: 'identity.account.unfreeze',
    userId: '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
    reason: 'Customer verified by phone',
    version: '3',
  } as const;
  it('reads exactly the account, the reason and the version, and names the account in the phrase and the description', () => {
    expect(readDeskRequest(unfreeze)).toEqual(unfreeze);
    expect(readDeskRequest({ ...unfreeze, version: '-1' })).toBeNull();
    expect(readDeskRequest({ ...unfreeze, userId: 'not-a-uuid' })).toBeNull();
    expect(readDeskRequest({ ...unfreeze, reason: 'short' })).toBeNull();
    expect(readDeskRequest({ ...unfreeze, extra: true })).toBeNull();
    expect(confirmPhrase(unfreeze)).toBe('UNFREEZE ACCOUNT 0b6f7a3e');
    expect(describeRequest(unfreeze)).toContain('stay revoked');
    expect(requestReason(unfreeze)).toBe(unfreeze.reason);
  });
});

describe('identity staff close and reopen requests', () => {
  const close = {
    kind: 'identity.account.close',
    userId: '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
    reasonCode: 'bank_reason',
    reason: 'Bank asked to end the relationship',
    version: '2',
  } as const;
  const reopen = { kind: 'identity.account.reopen', userId: close.userId, reason: 'Customer asked to come back', version: '3' } as const;
  it('reads exactly the account, reason code, reason and version', () => {
    expect(readDeskRequest(close)).toEqual(close);
    expect(readDeskRequest(reopen)).toEqual(reopen);
    expect(readDeskRequest({ ...close, reasonCode: 'boredom' })).toBeNull();
    expect(readDeskRequest({ ...reopen, reasonCode: 'fraud' })).toBeNull();
    expect(readDeskRequest({ ...close, reason: 'x'.repeat(256) })).toBeNull();
    expect(readDeskRequest({ ...close, userId: close.userId.toUpperCase() })).toBeNull();
  });
  it('names the account in the phrase and says whether it can be reopened', () => {
    expect(confirmPhrase(close)).toBe('CLOSE ACCOUNT 0b6f7a3e');
    expect(confirmPhrase(reopen)).toBe('REOPEN ACCOUNT 0b6f7a3e');
    expect(describeRequest(close)).toContain('it cannot be reopened');
    expect(describeRequest({ ...close, reasonCode: 'customer_request' })).toContain('can be reopened later');
    expect(requestReason(reopen)).toBe(reopen.reason);
  });
  it('keeps the same reason codes as identity', () => {
    expect([...CLOSE_REASON_CODES]).toEqual([...accountCloseReasonCodes]);
  });
});

describe('identity customer archive requests', () => {
  const archive = {
    kind: 'identity.account.archive',
    userId: '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
    reasonCode: 'dormant',
    reason: 'Closed two years ago, no contact since',
    version: '4',
  } as const;
  it('reads exactly the account, reason code, reason and version', () => {
    expect(readDeskRequest(archive)).toEqual(archive);
    expect(readDeskRequest({ ...archive, reasonCode: 'fraud' })).toBeNull();
    expect(readDeskRequest({ ...archive, reason: 'x'.repeat(256) })).toBeNull();
    expect(readDeskRequest({ ...archive, version: '04' })).toBeNull();
    expect(readDeskRequest({ ...archive, extra: '1' })).toBeNull();
  });
  it('names the customer in the phrase and says it cannot be undone', () => {
    expect(confirmPhrase(archive)).toBe('ARCHIVE CUSTOMER 0b6f7a3e');
    expect(describeRequest(archive)).toContain('read-only');
    expect(describeRequest(archive)).toContain('Only a founder can approve it');
    expect(requestReason(archive)).toBe(archive.reason);
  });
  it('keeps the same reason codes as identity', () => {
    expect([...ARCHIVE_REASON_CODES]).toEqual([...accountArchiveReasonCodes]);
  });
});

describe('identity account tier move requests', () => {
  const move = {
    kind: 'identity.account.tier_move',
    userId: '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
    tierId: 'plus',
    reason: 'Customer qualifies for plus',
    version: '0',
  } as const;
  it('reads exactly the account, tier, reason and version', () => {
    expect(readDeskRequest(move)).toEqual(move);
    expect(readDeskRequest({ ...move, tierId: 'Plus' })).toBeNull();
    expect(readDeskRequest({ ...move, tierId: 'x'.repeat(33) })).toBeNull();
    expect(readDeskRequest({ ...move, reason: 'x'.repeat(256) })).toBeNull();
    expect(readDeskRequest({ ...move, extra: '1' })).toBeNull();
  });
  it('names the account in the phrase and the tier in the description', () => {
    expect(confirmPhrase(move)).toBe('MOVE TIER 0b6f7a3e');
    expect(describeRequest(move)).toContain('onto tier "plus"');
    expect(requestReason(move)).toBe(move.reason);
  });
});

describe('identity account limit override requests', () => {
  const raise = {
    kind: 'identity.account.limit_override',
    userId: '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
    rail: 'withdrawal',
    assetId: 'USDT',
    perTx: '2000',
    rolling24h: null,
    expiresAt: '2026-10-25T12:00:00.000Z',
    reason: 'Customer is moving house this week',
    version: '0',
  } as const;
  it('reads exactly the account, rail, asset, figures, end time, reason and version', () => {
    expect(readDeskRequest(raise)).toEqual(raise);
    expect(readDeskRequest({ ...raise, rail: 'deposit' })).toBeNull();
    expect(readDeskRequest({ ...raise, assetId: 'usdt' })).toBeNull();
    expect(readDeskRequest({ ...raise, perTx: '0' })).toBeNull();
    expect(readDeskRequest({ ...raise, perTx: 2000 })).toBeNull();
    expect(readDeskRequest({ ...raise, perTx: null })).toBeNull();
    // Only the canonical instant: another spelling of the same time would hash differently.
    expect(readDeskRequest({ ...raise, expiresAt: '2026-10-25T14:00:00+02:00' })).toBeNull();
    expect(readDeskRequest({ ...raise, reason: 'too short' })).toBeNull();
    expect(readDeskRequest({ ...raise, extra: '1' })).toBeNull();
  });
  it('names the account in the phrase and the figures and end time in the description', () => {
    expect(confirmPhrase(raise)).toBe('RAISE LIMIT 0b6f7a3e');
    expect(describeRequest(raise)).toContain('per transaction 2000, over 24 hours the base figure');
    expect(describeRequest(raise)).toContain('until 2026-10-25T12:00:00.000Z');
    expect(requestReason(raise)).toBe(raise.reason);
  });
});
