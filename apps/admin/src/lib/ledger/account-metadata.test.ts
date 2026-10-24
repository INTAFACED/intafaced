import { describe, expect, it } from 'vitest';
import { readDeskRequest, confirmPhrase, describeRequest } from '@/lib/desk/approval-packet';
import { metadataSetBody, parseAccountMetadata, parseMetadataWrite, revisionOf, type AccountMetadata } from './account-metadata';
import { decodeMetadataDelete } from './account-metadata-delete';

/**
 * The console's side of account metadata (J-ops-console-03 #6, #7): what it accepts from svc-ledger, what it will send, the
 * two-founder delete request, and how an approved delete's answer reads. TEST labels only.
 */

const ACCOUNT = '0b4f6c2e-1111-4222-8333-444455556666';
const CHANGE = {
  seq: '9',
  key: 'desk.label',
  action: 'delete',
  before: 'TEST',
  after: null,
  revision: 2,
  requesterId: 'founder-a',
  approverId: 'founder-b',
  reason: 'LOCAL TEST remove the desk label',
  recordedAt: '2026-10-24T12:00:00.000Z',
};
const READ = {
  accountId: ACCOUNT,
  address: 'user:aaaa',
  entries: [{ key: 'desk.note', value: 'TEST', revision: 1, updatedAt: '2026-10-24T12:00:00.000Z', updatedBy: 'founder-a' }],
  deleted: [{ key: 'desk.label', revision: 2 }],
  changes: [CHANGE],
  frozen: true,
};

describe('reading svc-ledger’s answer', () => {
  it('takes the account it asked for, and refuses another account or a malformed row', () => {
    const parsed = parseAccountMetadata(READ, ACCOUNT) as AccountMetadata;
    expect(parsed).toMatchObject({ address: 'user:aaaa', frozen: true });
    expect(parsed.changes[0]).toMatchObject({ action: 'delete', before: 'TEST', approverId: 'founder-b' });
    expect(parseAccountMetadata({ ...READ, accountId: '11111111-1111-4111-8111-111111111111' }, ACCOUNT)).toBeNull();
    expect(parseAccountMetadata({ ...READ, entries: [{ key: 'desk.note', value: 5 }] }, ACCOUNT)).toBeNull();
    expect(parseAccountMetadata({ ...READ, changes: [{ ...CHANGE, action: 'edit' }] }, ACCOUNT)).toBeNull();
    expect(parseMetadataWrite({ accountId: ACCOUNT, change: CHANGE }, ACCOUNT)).toMatchObject({ key: 'desk.label' });
  });

  it('starts a set from the revision the ledger holds: the value’s, a deleted key’s, or 0', () => {
    const parsed = parseAccountMetadata(READ, ACCOUNT) as AccountMetadata;
    expect(revisionOf(parsed, 'desk.note')).toBe(1);
    expect(revisionOf(parsed, 'desk.label')).toBe(2);
    expect(revisionOf(parsed, 'desk.new')).toBe(0);
  });
});

describe('what the console sends', () => {
  const body = { key: 'desk.label', value: 'TEST', reason: 'LOCAL TEST label for the desk', revision: 0 };

  it('a set body exactly as svc-ledger takes it, and nothing it would refuse', () => {
    expect(metadataSetBody(body)).toEqual(body);
    for (const bad of [
      { ...body, key: 'Desk Label' },
      { ...body, value: '' },
      { ...body, value: 'x'.repeat(501) },
      { ...body, reason: 'too short' },
      { ...body, reason: ' LOCAL TEST padded reason' },
      { ...body, revision: -1 },
      { ...body, revision: '0' },
      { ...body, accountId: ACCOUNT },
    ]) {
      expect(metadataSetBody(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('a delete request with the account, key, reason and revision, and nothing else', () => {
    const request = { kind: 'ledger.account_metadata.delete', accountId: ACCOUNT, key: 'desk.label', reason: CHANGE.reason, version: '1' };
    expect(readDeskRequest(request)).toEqual(request);
    expect(confirmPhrase(readDeskRequest(request)!)).toBe('DELETE KEY desk.label');
    expect(describeRequest(readDeskRequest(request)!)).toContain('no posting, balance or transaction changes');
    for (const bad of [
      { ...request, version: '0' },
      { ...request, key: 'Desk' },
      { ...request, accountId: 'not-an-id' },
      { ...request, value: 'x' },
    ]) {
      expect(readDeskRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('an approved delete’s answer', () => {
  it('reads the delete of the key asked for, names both founders, and keeps svc-ledger’s refusal codes', () => {
    const done = decodeMetadataDelete({ reached: true, status: 200, body: { accountId: ACCOUNT, change: CHANGE } }, ACCOUNT, 'desk.label');
    expect(done).toMatchObject({ ok: true });
    expect(done.ok && done.detail).toContain('approved by founder-b');
    // Another key's change is not this delete.
    expect(
      decodeMetadataDelete({ reached: true, status: 200, body: { accountId: ACCOUNT, change: CHANGE } }, ACCOUNT, 'desk.note'),
    ).toMatchObject({
      ok: false,
      refusal: { changed: 'unknown' },
    });
    const frozen = decodeMetadataDelete(
      { reached: true, status: 412, body: { message: 'Ledger posting is frozen: LOCAL TEST', code: 'ledger.frozen' } },
      ACCOUNT,
      'desk.label',
    );
    expect(frozen).toMatchObject({ ok: false, refusal: { code: 'ledger.frozen', changed: 'no', title: 'The ledger is frozen' } });
    const stale = decodeMetadataDelete(
      { reached: true, status: 409, body: { message: 'changed', code: 'ledger.account_metadata_stale' } },
      ACCOUNT,
      'desk.label',
    );
    expect(stale).toMatchObject({ ok: false, refusal: { code: 'ledger.account_metadata_stale', changed: 'no' } });
    expect(decodeMetadataDelete({ reached: false, sent: true, detail: 'cut' }, ACCOUNT, 'desk.label')).toMatchObject({
      ok: false,
      refusal: { changed: 'unknown' },
    });
  });
});
