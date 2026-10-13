import { describe, expect, it } from 'vitest';
import { createOpenGate, draftOf } from './crm-open-gate';

type Record = { id: string; owner: string; stage: string; description: string };
const records: { [id: string]: Record } = {
  A: { id: 'A', owner: 'u-nitro', stage: 'new', description: 'Call A' },
  B: { id: 'B', owner: 'u-phantom', stage: 'qualified', description: 'Call B' },
};
const toDetail = (r: Record) => ({
  opportunity: { ownerUserId: r.owner, stage: r.stage, nextAction: { description: r.description, dueAt: '2026-10-20T09:00:00Z' } },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

/** The same steps CrmWorkspace.open() takes, with the screen replaced by a plain object. */
function makeScreen() {
  const gate = createOpenGate();
  const screen = { detailId: '', draft: draftOf(toDetail(records.A!), String), mobileDetail: false };
  async function open(id: string, silent: boolean, fetchRecord: () => Promise<Record>) {
    const call = gate.begin();
    const record = await fetchRecord();
    const decision = gate.settle(call, id, silent);
    if (!decision.apply) return false;
    screen.detailId = record.id;
    if (decision.showMobileDetail) screen.mobileDetail = true;
    if (decision.changedRecord) screen.draft = draftOf(toDetail(record), String);
    return true;
  }
  return { gate, screen, open };
}

describe('open gate (M1: stale responses)', () => {
  it("two opens resolving out of order end on the latest selection with that record's draft", async () => {
    const { screen, open } = makeScreen();
    await open('A', false, async () => records.A!); // A is on screen
    const background = deferred<Record>();
    const click = deferred<Record>();
    const refreshA = open('A', true, () => background.promise); // focus event: background refresh of A
    const openB = open('B', false, () => click.promise); // founder clicks row B
    click.resolve(records.B!);
    await openB;
    background.resolve(records.A!); // A's response lands last
    await refreshA;
    expect(screen.detailId).toBe('B');
    expect(screen.draft).toEqual({
      newOwner: 'u-phantom',
      newStage: 'qualified',
      actionDescription: 'Call B',
      actionDue: '2026-10-20T09:00:00Z',
    });
  });

  it('a stale result of the older non-silent call is dropped too', async () => {
    const { screen, open } = makeScreen();
    const slowA = deferred<Record>();
    const fastB = deferred<Record>();
    const first = open('A', false, () => slowA.promise);
    const second = open('B', false, () => fastB.promise);
    fastB.resolve(records.B!);
    await second;
    slowA.resolve(records.A!);
    expect(await first).toBe(false);
    expect(screen.detailId).toBe('B');
  });

  it('drops a background result when the founder has since moved to another enquiry', async () => {
    const { gate, screen, open } = makeScreen();
    await open('B', false, async () => records.B!);
    const late = deferred<Record>();
    const refresh = open('A', true, () => late.promise); // silent open of an enquiry that is not on screen
    late.resolve(records.A!);
    expect(await refresh).toBe(false);
    expect(gate.selected()).toBe('B');
    expect(screen.detailId).toBe('B');
  });
});

describe('open gate (M2: phone back button)', () => {
  it('only a non-silent open shows the phone detail view', async () => {
    const { screen, open } = makeScreen();
    await open('A', false, async () => records.A!);
    expect(screen.mobileDetail).toBe(true);
    screen.mobileDetail = false; // founder presses "Back to the list"
    await open('A', true, async () => records.A!); // 60 s background refresh
    expect(screen.mobileDetail).toBe(false);
    await open('A', false, async () => records.A!); // founder opens it again
    expect(screen.mobileDetail).toBe(true);
  });

  it('a silent refresh of the same record is not a changed record, so the draft is kept', () => {
    const gate = createOpenGate();
    const first = gate.begin();
    expect(gate.settle(first, 'A', false)).toEqual({ apply: true, changedRecord: true, showMobileDetail: true });
    const second = gate.begin();
    expect(gate.settle(second, 'A', true)).toEqual({ apply: true, changedRecord: false, showMobileDetail: false });
  });
});
