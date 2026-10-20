import { describe, expect, it } from 'vitest';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { MemoryCommandLog } from '../preferences/account.js';
import { MemoryNoticeStore, NoticeBoard, NoticeError, type NoticeApprovalConsumer } from './board.js';
import { normaliseChangelog, retiredEndpoints, upcomingEntries } from './changelog.js';

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';

class Approvals implements NoticeApprovalConsumer {
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    return {
      approvalId: input.approvalId,
      actionType: 'notify.notice.publish',
      targetService: input.targetService,
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      payloadHash: input.payloadHash,
      requesterId: AUTHOR,
      approverId: APPROVER,
      policyVersion: 'v1',
      createdAt: '2026-10-17T00:00:00.000Z',
      expiresAt: '2026-10-17T01:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    };
  }
}

function harness(start: string) {
  let now = new Date(start);
  const board = new NoticeBoard(new MemoryNoticeStore(), new Approvals(), new MemoryCommandLog(), () => now);
  let n = 0;
  return {
    board,
    at(iso: string) {
      now = new Date(iso);
    },
    async publish(input: Parameters<NoticeBoard['draft']>[1]) {
      n += 1;
      const draft = await board.draft(AUTHOR, input);
      return board.publish(AUTHOR, { id: draft.id, clientRequestId: `pub-${n}`, approvalId: `appr-${n}`, operationId: `op-${n}` });
    },
  };
}

const entry = (key: string, changelog: Record<string, unknown>, title = 'Test change') => ({
  kind: 'changelog',
  title,
  body: 'Test body',
  changelog,
  clientRequestId: key,
});

const refused = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err instanceof NoticeError ? err.code : 'other';
  }
  return 'accepted';
};

describe('changelog fields', () => {
  it('lists a published breaking entry under its area with the flag, and on the upcoming list until its date', async () => {
    const h = harness('2026-10-17T12:00:00.000Z');
    await h.publish(
      entry('c1', { area: 'trading', breaking: true, releaseOn: '2026-11-01', migrationNote: 'Send the new field.', retired: ['/v1/old'] }),
    );
    const listed = await h.board.changelog({ area: 'trading', limit: 10 });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.changelog).toMatchObject({ area: 'trading', breaking: true, releaseOn: '2026-11-01' });
    expect((await h.board.upcomingChanges()).upcoming.map((e) => e.id)).toEqual([listed[0]?.id]);
    h.at('2026-11-02T00:00:00.000Z');
    expect((await h.board.upcomingChanges()).upcoming).toEqual([]);
    expect((await h.board.changelog({ breaking: true, limit: 10 })).length).toBe(1);
  });

  it('reads an entry with no release date as not set and never lists it as upcoming', async () => {
    const h = harness('2026-10-17T12:00:00.000Z');
    await h.publish(entry('c2', { area: 'account', breaking: true, migrationNote: 'Read the note.' }));
    const [one] = await h.board.changelog({ limit: 10 });
    expect(one?.changelog?.releaseOn).toBeNull();
    expect((await h.board.upcomingChanges()).upcoming).toEqual([]);
  });

  it('shows a retired endpoint on the retired list with its entry and date, the earliest date winning', async () => {
    const h = harness('2026-10-17T12:00:00.000Z');
    const a = await h.publish(entry('c3', { area: 'wallet', retired: ['/v1/withdraw'], releaseOn: '2026-12-01' }, 'Later'));
    const b = await h.publish(entry('c4', { area: 'wallet', retired: ['/v1/withdraw', '/v1/ping'], releaseOn: '2026-11-01' }, 'Sooner'));
    const { retired } = await h.board.upcomingChanges();
    expect(retired).toEqual([
      { endpoint: '/v1/ping', entryId: b.id, title: 'Sooner', releaseOn: '2026-11-01' },
      { endpoint: '/v1/withdraw', entryId: b.id, title: 'Sooner', releaseOn: '2026-11-01' },
    ]);
    expect(a.id).not.toBe(b.id);
  });

  it('filters by area and by the breaking flag, newest first', async () => {
    const h = harness('2026-10-17T12:00:00.000Z');
    await h.publish(entry('c5', { area: 'trading' }, 'one'));
    h.at('2026-10-18T12:00:00.000Z');
    await h.publish(entry('c6', { area: 'trading', breaking: true, migrationNote: 'n' }, 'two'));
    await h.publish(entry('c7', { area: 'webhooks' }, 'three'));
    expect((await h.board.changelog({ area: 'trading', limit: 10 })).map((e) => e.title)).toEqual(['two', 'one']);
    expect((await h.board.changelog({ breaking: true, limit: 10 })).map((e) => e.title)).toEqual(['two']);
    expect(await h.board.changelog({ limit: 10 })).toHaveLength(3);
  });

  it('refuses a breaking entry with no migration note, an unknown or missing area, a bad date and half an example', async () => {
    const h = harness('2026-10-17T12:00:00.000Z');
    expect(await refused(h.board.draft(AUTHOR, entry('r1', { area: 'trading', breaking: true })))).toBe(
      'notify.changelog_migration_note_unset',
    );
    expect(await refused(h.board.draft(AUTHOR, entry('r2', { area: 'nope' })))).toBe('notify.changelog_area_unknown');
    expect(await refused(h.board.draft(AUTHOR, entry('r3', { breaking: false })))).toBe('notify.changelog_area_unset');
    expect(await refused(h.board.draft(AUTHOR, entry('r4', { area: 'fix', releaseOn: '2026-02-31' })))).toBe(
      'notify.changelog_date_invalid',
    );
    expect(await refused(h.board.draft(AUTHOR, entry('r5', { area: 'fix', addedOn: '2026-11-02', releaseOn: '2026-11-01' })))).toBe(
      'notify.changelog_date_invalid',
    );
    expect(await refused(h.board.draft(AUTHOR, entry('r6', { area: 'fix', before: 'x' })))).toBe('notify.changelog_example_incomplete');
    expect(
      await refused(
        h.board.draft(AUTHOR, { kind: 'announcement', title: 't', body: 'b', changelog: { area: 'fix' }, clientRequestId: 'r7' }),
      ),
    ).toBe('notify.changelog_fields_invalid');
  });

  it('keeps a draft out of every read until it is published, and an entry without fields reads with none', async () => {
    const h = harness('2026-10-17T12:00:00.000Z');
    await h.board.draft(AUTHOR, entry('d1', { area: 'trading' }));
    await h.publish({ kind: 'changelog', title: 'Old style', body: 'b', clientRequestId: 'd2' });
    const listed = await h.board.changelog({ limit: 10 });
    expect(listed.map((e) => e.title)).toEqual(['Old style']);
    expect(listed[0]?.changelog).toBeNull();
  });

  it('binds the changelog fields into the publish approval hash', async () => {
    const seen: string[] = [];
    const board = new NoticeBoard(
      new MemoryNoticeStore(),
      {
        async consume(input) {
          seen.push(input.payloadHash);
          return new Approvals().consume(input);
        },
      },
      new MemoryCommandLog(),
    );
    for (const [key, area] of [
      ['h1', 'trading'],
      ['h2', 'wallet'],
    ] as const) {
      const draft = await board.draft(AUTHOR, { ...entry(key, { area }), title: 'Same', body: 'Same' });
      await board.publish(AUTHOR, { id: draft.id, clientRequestId: `p-${key}`, approvalId: `a-${key}`, operationId: `o-${key}` });
    }
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('changelog helpers', () => {
  it('trims and de-duplicates lists, and treats blank text as unset', () => {
    const out = normaliseChangelog({ area: 'fix', endpoints: [' /a ', '/a', ''], migrationNote: '   ' });
    expect(out.endpoints).toEqual(['/a']);
    expect(out.migrationNote).toBeNull();
    expect(out.breaking).toBe(false);
  });

  it('puts the soonest release first and drops entries already in effect', () => {
    const e = (id: string, releaseOn: string | null, breaking = true) => ({
      id,
      title: id,
      publishedAt: null,
      changelog: normaliseChangelog({ area: 'fix', breaking, releaseOn, migrationNote: 'n' }),
    });
    const at = new Date('2026-10-20T00:00:00.000Z');
    expect(
      upcomingEntries(
        [e('b', '2026-12-01'), e('a', '2026-10-20'), e('old', '2026-10-19'), e('none', null), e('minor', '2026-11-01', false)],
        at,
      ).map((x) => x.id),
    ).toEqual(['a', 'b']);
    expect(retiredEndpoints([])).toEqual([]);
  });
});
