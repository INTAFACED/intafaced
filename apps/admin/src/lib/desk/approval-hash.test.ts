import { describe, expect, it } from 'vitest';
import { edgeActionPayloadHash } from '../../../../../services/svc-edge/src/action-approval-consume';
import { academyActionPayloadHash } from '../../../../../services/svc-academy/src/action-approval-consume';
import { marketActionPayloadHash } from '../../../../../services/svc-market/src/action-approval-consume';
import { bankActionPayloadHash } from '../../../../../services/svc-bank/src/action-approval-consume';
import { ledgerActionPayloadHash } from '../../../../../services/svc-ledger/src/ledger/action-approval-consume';
import {
  ACCOUNT_METADATA_DELETE_ACTION,
  ACCOUNT_METADATA_DELETE_TARGET,
  accountMetadataDeleteFields,
} from '../../../../../services/svc-ledger/src/ledger/operator-account-metadata';
import { identityActionPayloadHash } from '../../../../../services/svc-identity/src/auth/privileged-dual-control';
import { AUTH_KEY_REMOVE_OLD_TARGET, AUTH_KEY_ROTATE_TARGET } from '../../../../../services/svc-identity/src/auth/auth-key-ring';
import {
  IDENTITY_ARCHIVE_ACTION_TYPE,
  IDENTITY_CLOSE_ACTION_TYPE,
  IDENTITY_REOPEN_ACTION_TYPE,
  IDENTITY_TIER_MOVE_ACTION_TYPE,
  IDENTITY_LIMIT_CHANGE_ACTION_TYPE,
  IDENTITY_UNFREEZE_ACTION_TYPE,
} from '../../../../../services/svc-identity/src/auth/action-approval-audience';
import { payActionPayloadHash } from '../../../../../services/svc-pay/src/action-approval-consume';
import { tokenActionPayloadHash } from '../../../../../services/svc-token/src/action-approval-consume';
import {
  LAUNCH_EVENT_CREATE_ACTION,
  LAUNCH_EVENT_MOVE_ACTION,
  LAUNCH_ISSUER_SET_ACTION,
  launchEventPayload,
} from '../../../../../services/svc-token/src/launch/payload';
import { createInputFor, draftPayload, readLaunchEventPayload } from '@/lib/launch-issuers/model';
import { readDeskRequest } from './approval-packet';
import { payloadHashFor, proposeInputFor } from './approval-hash';

/**
 * The hash is the whole binding between what the approver read and what the service will do. If it drifts from the
 * services' own functions every approval becomes unusable (safe but broken), so it is pinned to THEIR code, not to a
 * copy of ours.
 */
describe('payload hash equals the owning service’s own function', () => {
  it('edge.kill: kill and re-enable, with the reason as typed', () => {
    for (const disabled of [true, false]) {
      expect(payloadHashFor({ kind: 'edge.kill', module: 'trade', disabled, reason: 'market integrity incident' })).toBe(
        edgeActionPayloadHash('edge.kill', { module: 'trade', disabled: disabled ? 'true' : 'false', reason: 'market integrity incident' }),
      );
    }
  });
  it('ledger.freeze and ledger.unfreeze', () => {
    expect(payloadHashFor({ kind: 'ledger.freeze', reason: 'reconciliation mismatch on USD', version: 'v' })).toBe(
      ledgerActionPayloadHash('ledger.freeze', { reason: 'reconciliation mismatch on USD' }),
    );
    expect(payloadHashFor({ kind: 'ledger.unfreeze', version: 'v' })).toBe(ledgerActionPayloadHash('ledger.unfreeze', {}));
  });
  it('ledger.reconciliation_control.run binds the control, instant, margin and reason in svc-ledger’s order', () => {
    const controlId = '0b4f6c2e-1111-4222-8333-444455556666';
    const reason = 'LOCAL TEST run the USDT floor control';
    for (const [asOf, margin] of [
      ['now', 'unset'],
      ['2026-10-23T06:30:00.000Z', '0'],
    ] as const) {
      expect(payloadHashFor({ kind: 'ledger.reconciliation_control.run', controlId, version: '3', asOf, margin, reason })).toBe(
        ledgerActionPayloadHash('ledger.reconciliation_control.run', { controlId, asOf, margin, reason }),
      );
    }
    expect(
      proposeInputFor({ kind: 'ledger.reconciliation_control.run', controlId, version: '3', asOf: 'now', margin: 'unset', reason }),
    ).toMatchObject({
      actionType: 'ledger.reconciliation_control.run',
      targetService: 'svc-ledger',
      targetId: 'posting_reconciliation_control.run',
      expectedVersion: '3',
    });
  });
  it('ledger.reconciliation_control.lifecycle binds the control, the move and the reason, at the control version', () => {
    const controlId = '0b4f6c2e-1111-4222-8333-444455556666';
    const reason = 'LOCAL TEST pause while the rail is down';
    for (const lifecycle of ['pause', 'resume', 'retire'] as const) {
      const request = { kind: 'ledger.reconciliation_control.lifecycle', controlId, version: '4', lifecycle, reason } as const;
      expect(payloadHashFor(request)).toBe(
        ledgerActionPayloadHash('ledger.reconciliation_control.lifecycle', { controlId, lifecycle, reason }),
      );
      expect(proposeInputFor(request)).toMatchObject({
        actionType: 'ledger.reconciliation_control.lifecycle',
        targetService: 'svc-ledger',
        targetId: 'posting_reconciliation_control.lifecycle',
        expectedVersion: '4',
      });
    }
  });
  it('ledger.account_metadata.delete binds the account, key and reason as svc-ledger does, at the key’s revision', () => {
    const request = {
      kind: 'ledger.account_metadata.delete',
      accountId: '0b4f6c2e-1111-4222-8333-444455556666',
      key: 'desk.label',
      reason: 'LOCAL TEST remove the desk label',
      version: '2',
    } as const;
    expect(payloadHashFor(request)).toBe(ledgerActionPayloadHash(ACCOUNT_METADATA_DELETE_ACTION, accountMetadataDeleteFields(request)));
    expect(proposeInputFor(request)).toMatchObject({
      actionType: ACCOUNT_METADATA_DELETE_ACTION,
      targetService: 'svc-ledger',
      targetId: ACCOUNT_METADATA_DELETE_TARGET,
      expectedVersion: '2',
    });
  });
  it('market.vendor.vet and the academy ambassador verbs', () => {
    const vendorId = '5a3b9c10-1111-4222-8333-444455556666';
    const userId = '9f8e7d6c-1111-4222-8333-444455556666';
    for (const decision of ['approved', 'rejected', 'suspended'] as const) {
      expect(payloadHashFor({ kind: 'market.vendor.vet', vendorId, decision, reason: 'documents checked fully' })).toBe(
        marketActionPayloadHash('market.vendor.vet', { vendorId, decision, reason: 'documents checked fully' }),
      );
    }
    expect(payloadHashFor({ kind: 'academy.ambassador.freeze', userId, reason: 'conduct complaint review' })).toBe(
      academyActionPayloadHash('academy.ambassador.freeze', { userId, reason: 'conduct complaint review' }),
    );
    expect(payloadHashFor({ kind: 'academy.ambassador.unfreeze', userId })).toBe(
      academyActionPayloadHash('academy.ambassador.unfreeze', { userId }),
    );
  });
  it('academy appoint and residency decision', () => {
    const userId = '9f8e7d6c-1111-4222-8333-444455556666';
    const id = '5a3b9c10-1111-4222-8333-444455556666';
    expect(payloadHashFor({ kind: 'academy.ambassador.appoint', userId })).toBe(
      academyActionPayloadHash('academy.ambassador.appoint', { userId }),
    );
    for (const decision of ['accepted', 'rejected'] as const) {
      expect(payloadHashFor({ kind: 'academy.residency.decide', id, decision })).toBe(
        academyActionPayloadHash('academy.residency.decide', { id, decision }),
      );
    }
    expect(payloadHashFor({ kind: 'academy.residency.decide', id, decision: 'accepted' })).not.toBe(
      payloadHashFor({ kind: 'academy.residency.decide', id, decision: 'rejected' }),
    );
  });
  it('the decision is part of the vendor hash: approve and reject never share one', () => {
    const base = {
      kind: 'market.vendor.vet',
      vendorId: '5a3b9c10-1111-4222-8333-444455556666',
      reason: 'documents checked fully',
    } as const;
    expect(payloadHashFor({ ...base, decision: 'approved' })).not.toBe(payloadHashFor({ ...base, decision: 'rejected' }));
  });
  it('the reason is part of the hash: a different reason is a different request', () => {
    const a = payloadHashFor({ kind: 'edge.kill', module: 'trade', disabled: true, reason: 'market integrity incident' });
    const b = payloadHashFor({ kind: 'edge.kill', module: 'trade', disabled: true, reason: 'market integrity incident!' });
    expect(a).not.toBe(b);
  });
  it('kill and re-enable of the same module never share a hash', () => {
    const kill = payloadHashFor({ kind: 'edge.kill', module: 'pay', disabled: true, reason: 'twelve chars!' });
    const resume = payloadHashFor({ kind: 'edge.kill', module: 'pay', disabled: false, reason: 'twelve chars!' });
    expect(kill).not.toBe(resume);
  });
});

describe('card freeze and listing takedown hashes equal the services’ own functions', () => {
  const cardId = '9f8e7d6c-1111-4222-8333-444455556666';
  const listingId = '5a3b9c10-1111-4222-8333-444455556666';
  it('bank.ops.setCardStatus binds the card and the status, with fields sorted under `fields`; the reason is not in it', () => {
    for (const status of ['frozen', 'active'] as const) {
      expect(payloadHashFor({ kind: 'bank.card.status', cardId, status, reason: 'owner reported the card stolen' })).toBe(
        bankActionPayloadHash('bank.ops.setCardStatus', { cardId, status }),
      );
    }
    expect(payloadHashFor({ kind: 'bank.card.status', cardId, status: 'frozen', reason: 'owner reported the card stolen' })).toBe(
      payloadHashFor({ kind: 'bank.card.status', cardId, status: 'frozen', reason: 'a different reason entirely' }),
    );
    expect(payloadHashFor({ kind: 'bank.card.status', cardId, status: 'frozen', reason: 'owner reported the card stolen' })).not.toBe(
      payloadHashFor({ kind: 'bank.card.status', cardId, status: 'active', reason: 'owner reported the card stolen' }),
    );
  });
  it('market.takedown binds the listing AND the reason, so a changed reason is a different request', () => {
    expect(payloadHashFor({ kind: 'market.listing.takedown', listingId, reason: 'sells a forbidden product' })).toBe(
      marketActionPayloadHash('market.takedown', { listingId, reason: 'sells a forbidden product' }),
    );
    expect(payloadHashFor({ kind: 'market.listing.takedown', listingId, reason: 'sells a forbidden product' })).not.toBe(
      payloadHashFor({ kind: 'market.listing.takedown', listingId, reason: 'sells a forbidden product!' }),
    );
  });
  it('are proposed against the target each service consumes: svc-bank by verb, svc-market by listing id', () => {
    expect(proposeInputFor({ kind: 'bank.card.status', cardId, status: 'frozen', reason: 'owner reported the card stolen' })).toMatchObject(
      {
        actionType: 'bank.ops.setCardStatus',
        targetService: 'svc-bank',
        targetId: 'bank.ops.setCardStatus',
        expectedVersion: '1',
        policyVersion: 'v1',
      },
    );
    expect(proposeInputFor({ kind: 'market.listing.takedown', listingId, reason: 'sells a forbidden product' })).toMatchObject({
      actionType: 'market.takedown',
      targetService: 'svc-market',
      targetId: listingId,
      expectedVersion: '1',
    });
  });
});

describe('the identity approval is proposed against the target the service consumes', () => {
  it('market vet and academy ambassador verbs target their own service and verb at version 1', () => {
    const vendorId = '5a3b9c10-1111-4222-8333-444455556666';
    const userId = '9f8e7d6c-1111-4222-8333-444455556666';
    expect(proposeInputFor({ kind: 'market.vendor.vet', vendorId, decision: 'approved', reason: 'documents checked fully' })).toMatchObject(
      {
        actionType: 'market.vendor.vet',
        targetService: 'svc-market',
        targetId: 'market.vendor.vet',
        expectedVersion: '1',
        policyVersion: 'v1',
      },
    );
    expect(proposeInputFor({ kind: 'academy.ambassador.freeze', userId, reason: 'conduct complaint review' })).toMatchObject({
      targetService: 'svc-academy',
      targetId: 'academy.ambassador.freeze',
    });
    expect(proposeInputFor({ kind: 'academy.ambassador.unfreeze', userId })).toMatchObject({
      targetService: 'svc-academy',
      targetId: 'academy.ambassador.unfreeze',
    });
  });
  it('academy appoint and residency decision target their own verb at version 1, the ids the service consumes against', () => {
    const userId = '9f8e7d6c-1111-4222-8333-444455556666';
    expect(proposeInputFor({ kind: 'academy.ambassador.appoint', userId })).toMatchObject({
      actionType: 'academy.ambassador.appoint',
      targetService: 'svc-academy',
      targetId: 'academy.ambassador.appoint',
      expectedVersion: '1',
      policyVersion: 'v1',
    });
    expect(proposeInputFor({ kind: 'academy.residency.decide', id: userId, decision: 'rejected' })).toMatchObject({
      actionType: 'academy.residency.decide',
      targetService: 'svc-academy',
      targetId: 'academy.residency.decide',
      expectedVersion: '1',
    });
  });
  it('edge kill targets svc-edge kill:<module> at version 1', () => {
    expect(proposeInputFor({ kind: 'edge.kill', module: 'pay', disabled: true, reason: 'twelve chars!' })).toMatchObject({
      actionType: 'edge.kill',
      targetService: 'svc-edge',
      targetId: 'kill:pay',
      expectedVersion: '1',
      policyVersion: 'v1',
    });
  });
  it('ledger freeze and unfreeze target the ledger verbs, bound to the ledger’s own version', () => {
    const version = '2026-10-17 03:00:00.123456+00';
    expect(proposeInputFor({ kind: 'ledger.freeze', reason: 'reconciliation mismatch', version })).toMatchObject({
      actionType: 'ledger.freeze',
      targetService: 'svc-ledger',
      targetId: 'posting_freeze',
      expectedVersion: version,
    });
    expect(proposeInputFor({ kind: 'ledger.unfreeze', version })).toMatchObject({
      actionType: 'ledger.unfreeze',
      targetService: 'svc-ledger',
      targetId: 'posting_unfreeze',
      expectedVersion: version,
    });
  });
});

describe('waitlist wave release', () => {
  it('hash equals identity’s own function over { wave, size } and is proposed against waitlist.wave.release', () => {
    const request = { kind: 'campaigns.waitlist.wave_release', wave: '3', size: '2' } as const;
    expect(payloadHashFor(request)).toBe(identityActionPayloadHash('waitlist.wave.release', { wave: '3', size: '2' }));
    expect(proposeInputFor(request)).toMatchObject({
      actionType: 'waitlist.wave.release',
      targetService: 'svc-identity',
      targetId: 'waitlist.wave.release',
      expectedVersion: '1',
    });
    expect(payloadHashFor(request)).not.toBe(payloadHashFor({ ...request, size: '3' }));
  });
});

describe('identity signing-key changes', () => {
  it('hash equals identity’s own function and is proposed against the target identity consumes', () => {
    expect(payloadHashFor({ kind: 'identity.auth_key.rotate', keyId: 'k2' })).toBe(
      identityActionPayloadHash(AUTH_KEY_ROTATE_TARGET, { keyId: 'k2' }),
    );
    expect(payloadHashFor({ kind: 'identity.auth_key.remove_old', keyIds: 'k1,legacy' })).toBe(
      identityActionPayloadHash(AUTH_KEY_REMOVE_OLD_TARGET, { keyIds: 'k1,legacy' }),
    );
    expect(proposeInputFor({ kind: 'identity.auth_key.rotate', keyId: 'k2' })).toMatchObject({
      actionType: AUTH_KEY_ROTATE_TARGET,
      targetService: 'svc-identity',
      targetId: AUTH_KEY_ROTATE_TARGET,
      expectedVersion: '1',
    });
    expect(proposeInputFor({ kind: 'identity.auth_key.remove_old', keyIds: 'legacy' })).toMatchObject({
      actionType: AUTH_KEY_REMOVE_OLD_TARGET,
      targetId: AUTH_KEY_REMOVE_OLD_TARGET,
    });
  });
  it('a different key id is a different hash', () => {
    expect(payloadHashFor({ kind: 'identity.auth_key.rotate', keyId: 'k2' })).not.toBe(
      payloadHashFor({ kind: 'identity.auth_key.rotate', keyId: 'k3' }),
    );
  });
});

describe('pay deposit address unfreeze', () => {
  const request = {
    kind: 'pay.deposit_address.unfreeze' as const,
    userId: '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
    networkId: 'ethereum',
    address: '0x00000000000000000000000000000000000000A1',
    freezeId: '7d8c9b0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a',
    reason: 'Source cleared by compliance',
  };
  it('hash equals svc-pay’s own function over the freeze, the account, the address (lower case) and the reason', () => {
    // svc-pay `unfreezeApprovalFields`, in its order.
    expect(payloadHashFor(request)).toBe(
      payActionPayloadHash('pay.deposit_address_unfreeze', {
        freezeId: request.freezeId,
        userId: request.userId,
        networkId: 'ethereum',
        address: request.address.toLowerCase(),
        reason: request.reason,
      }),
    );
    expect(payloadHashFor({ ...request, freezeId: '8d8c9b0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a' })).not.toBe(payloadHashFor(request));
    expect(payloadHashFor({ ...request, reason: 'Another reason entirely' })).not.toBe(payloadHashFor(request));
  });
  it('is proposed against svc-pay’s own verb at version 1', () => {
    expect(proposeInputFor(request)).toEqual({
      actionType: 'pay.deposit_address_unfreeze',
      targetService: 'svc-pay',
      targetId: 'pay.deposit_address_unfreeze',
      expectedVersion: '1',
      payloadHash: payloadHashFor(request),
      policyVersion: 'v1',
    });
  });
});

describe('identity account unfreeze', () => {
  const request = {
    kind: 'identity.account.unfreeze' as const,
    userId: '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
    reason: 'Customer verified by phone',
    version: '3',
  };
  it('hash equals identity’s own function over the account and the reason', () => {
    expect(payloadHashFor(request)).toBe(identityActionPayloadHash(request.userId, { reason: request.reason }));
    expect(payloadHashFor({ ...request, reason: 'Another reason entirely' })).not.toBe(payloadHashFor(request));
  });
  it('is proposed against the account at the version the founder read', () => {
    expect(proposeInputFor(request)).toEqual({
      actionType: IDENTITY_UNFREEZE_ACTION_TYPE,
      targetService: 'svc-identity',
      targetId: request.userId,
      expectedVersion: '3',
      payloadHash: payloadHashFor(request),
      policyVersion: 'v1',
    });
  });
});

describe('identity staff close and reopen', () => {
  const userId = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  const close = {
    kind: 'identity.account.close' as const,
    userId,
    reasonCode: 'customer_request' as const,
    reason: 'Customer asked by letter',
    version: '4',
  };
  const reopen = { kind: 'identity.account.reopen' as const, userId, reason: 'Customer asked to come back', version: '5' };
  it('hash equals identity’s identityClosurePayloadHash: account, action, reason code (close only), reason, in that order', () => {
    expect(payloadHashFor(close)).toBe(
      identityActionPayloadHash(userId, { action: 'close', reasonCode: 'customer_request', reason: close.reason }),
    );
    expect(payloadHashFor(reopen)).toBe(identityActionPayloadHash(userId, { action: 'reopen', reason: reopen.reason }));
    expect(payloadHashFor({ ...close, reasonCode: 'fraud' })).not.toBe(payloadHashFor(close));
  });
  it('is proposed against the account at the version the founder read, under its own action type', () => {
    expect(proposeInputFor(close)).toEqual({
      actionType: IDENTITY_CLOSE_ACTION_TYPE,
      targetService: 'svc-identity',
      targetId: userId,
      expectedVersion: '4',
      payloadHash: payloadHashFor(close),
      policyVersion: 'v1',
    });
    expect(proposeInputFor(reopen)).toMatchObject({ actionType: IDENTITY_REOPEN_ACTION_TYPE, targetId: userId, expectedVersion: '5' });
  });
});

describe('identity customer archive', () => {
  const userId = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  const archive = {
    kind: 'identity.account.archive' as const,
    userId,
    reasonCode: 'dormant' as const,
    reason: 'Closed two years ago, no contact since',
    version: '7',
  };
  it('hash equals identity’s identityArchivePayloadHash: account, action, reason code, reason, in that order', () => {
    expect(payloadHashFor(archive)).toBe(
      identityActionPayloadHash(userId, { action: 'archive', reasonCode: 'dormant', reason: archive.reason }),
    );
    expect(payloadHashFor({ ...archive, reasonCode: 'duplicate' })).not.toBe(payloadHashFor(archive));
  });
  it('is proposed against the account at the control version the founder read, under its own action type', () => {
    expect(proposeInputFor(archive)).toEqual({
      actionType: IDENTITY_ARCHIVE_ACTION_TYPE,
      targetService: 'svc-identity',
      targetId: userId,
      expectedVersion: '7',
      payloadHash: payloadHashFor(archive),
      policyVersion: 'v1',
    });
  });
});

describe('identity account tier move', () => {
  const userId = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  const move = { kind: 'identity.account.tier_move' as const, userId, tierId: 'plus', reason: 'Customer qualifies for plus', version: '2' };
  it('hash equals identity’s identityTierPayloadHash: account, action, tier, reason, in that order', () => {
    expect(payloadHashFor(move)).toBe(identityActionPayloadHash(userId, { action: 'tier_move', tierId: 'plus', reason: move.reason }));
    expect(payloadHashFor({ ...move, tierId: 'standard' })).not.toBe(payloadHashFor(move));
  });
  it('is proposed against the account at the tier version the founder read, under the founder-only type', () => {
    expect(proposeInputFor(move)).toEqual({
      actionType: IDENTITY_TIER_MOVE_ACTION_TYPE,
      targetService: 'svc-identity',
      targetId: userId,
      expectedVersion: '2',
      payloadHash: payloadHashFor(move),
      policyVersion: 'v1',
    });
  });
});

describe('identity account limit override', () => {
  const userId = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  const raise = {
    kind: 'identity.account.limit_override' as const,
    userId,
    rail: 'withdrawal' as const,
    assetId: 'USDT',
    perTx: null,
    rolling24h: '8000',
    expiresAt: '2026-10-25T12:00:00.000Z',
    reason: 'Customer is moving house this week',
    version: '3',
  };
  it('hash equals identity’s identityLimitPayloadHash: account, action, rail, asset, figures (null as blank), end time, reason', () => {
    expect(payloadHashFor(raise)).toBe(
      identityActionPayloadHash(userId, {
        action: 'limit_override',
        rail: 'withdrawal',
        assetId: 'USDT',
        perTx: '',
        rolling24h: '8000',
        expiresAt: raise.expiresAt,
        reason: raise.reason,
      }),
    );
    for (const patch of [{ perTx: '8000' }, { rolling24h: '8001' }, { expiresAt: '2026-10-25T12:00:01.000Z' }, { assetId: 'BTC' }])
      expect(payloadHashFor({ ...raise, ...patch })).not.toBe(payloadHashFor(raise));
  });
  it('is proposed against the account at the override version the founder read, under the founder-only limit type', () => {
    expect(proposeInputFor(raise)).toEqual({
      actionType: IDENTITY_LIMIT_CHANGE_ACTION_TYPE,
      targetService: 'svc-identity',
      targetId: userId,
      expectedVersion: '3',
      payloadHash: payloadHashFor(raise),
      policyVersion: 'v1',
    });
  });
});

describe('token launch issuer lens (J-more-catalogue-14)', () => {
  const issuer = {
    kind: 'token.launch.issuer.set' as const,
    issuerId: 'test-issuer',
    name: 'TEST Issuer',
    state: 'onboarded' as const,
    revision: '2',
  };
  const move = { kind: 'token.launch.event.move' as const, eventId: 'test-launch', to: 'announced' as const, revision: '0' };
  const draft = draftPayload({
    id: 'test-launch',
    issuerId: 'test-issuer',
    type: 'token_sale',
    projectName: ' TEST Project ',
    symbol: 'tst',
    periods: ['2026-11-01T00:00', '2026-11-01T01:00', '2026-11-01T02:00', '2026-11-01T10:00', '2026-11-01T11:00'],
    method: 'pro_rata',
    perUserCap: '250',
    ticketSize: '',
    price: '0.5',
    paymentAsset: 'usdt',
    rateSource: '',
  });
  if (!draft.ok) throw new Error(draft.message);
  const create = { kind: 'token.launch.event.create' as const, event: draft.event };

  it('hash equals svc-token’s own function over the fields its launch router binds', () => {
    expect(payloadHashFor(issuer)).toBe(
      tokenActionPayloadHash(LAUNCH_ISSUER_SET_ACTION, {
        issuerId: 'test-issuer',
        name: 'TEST Issuer',
        state: 'onboarded',
        expectedRevision: '2',
      }),
    );
    expect(payloadHashFor(move)).toBe(
      tokenActionPayloadHash(LAUNCH_EVENT_MOVE_ACTION, { eventId: 'test-launch', to: 'announced', expectedRevision: '0' }),
    );
  });

  it('a draft’s text is svc-token’s canonical payload for the create input it sends, so its hash binds', () => {
    const payload = readLaunchEventPayload(draft.event);
    if (!payload) throw new Error('payload unreadable');
    const input = createInputFor(payload);
    const canonical = launchEventPayload({
      ...input,
      periods: Object.fromEntries(Object.entries(input.periods).map(([k, v]) => [k, new Date(v)])) as never,
    });
    expect(canonical).toBe(draft.event);
    expect(payloadHashFor(create)).toBe(tokenActionPayloadHash(LAUNCH_EVENT_CREATE_ACTION, { event: canonical }));
  });

  it('is proposed against svc-token’s own verb at the revision read, a new draft at 0', () => {
    expect(proposeInputFor(issuer)).toEqual({
      actionType: LAUNCH_ISSUER_SET_ACTION,
      targetService: 'svc-token',
      targetId: LAUNCH_ISSUER_SET_ACTION,
      expectedVersion: '2',
      payloadHash: payloadHashFor(issuer),
      policyVersion: 'v1',
    });
    expect(proposeInputFor(move)).toMatchObject({ targetId: LAUNCH_EVENT_MOVE_ACTION, expectedVersion: '0' });
    expect(proposeInputFor(create)).toMatchObject({ targetId: LAUNCH_EVENT_CREATE_ACTION, expectedVersion: '0' });
  });

  it('a packet carries only a request svc-token could accept', () => {
    expect(readDeskRequest(issuer)).toEqual(issuer);
    expect(readDeskRequest(create)).toEqual(create);
    expect(readDeskRequest({ ...create, event: draft.event.replace('"0.5"', '"0.50"') })).toBeNull();
    expect(readDeskRequest({ ...issuer, state: 'deleted' })).toBeNull();
    expect(readDeskRequest({ ...move, to: 'allocated' })).toBeNull();
    expect(readDeskRequest({ ...move, extra: 1 })).toBeNull();
  });
});
