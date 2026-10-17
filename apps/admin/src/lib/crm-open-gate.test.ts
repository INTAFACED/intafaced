import { describe, expect, it } from 'vitest';
import { createOpenGate, draftOf, followRecord, formAfterDiscard, rebaseActionFields, type ActionFields } from './crm-open-gate';

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

  it('a manual Refresh (reveal: false) applies the result but leaves the phone on the list the founder chose', () => {
    const gate = createOpenGate();
    gate.settle(gate.begin(), 'A', false);
    expect(gate.settle(gate.begin(), 'A', false, false)).toEqual({ apply: true, changedRecord: false, showMobileDetail: false });
    // Tapping a row for the enquiry already selected still opens the phone detail.
    expect(gate.settle(gate.begin(), 'A', false)).toEqual({ apply: true, changedRecord: false, showMobileDetail: true });
  });
});

describe('next-action fields after a same-enquiry refresh (M1: stale editor)', () => {
  const loaded = { description: 'Review enquiry', due: '2026-10-14' };
  const untouched: ActionFields = {
    editDescription: loaded.description,
    editDue: loaded.due,
    actionDescription: loaded.description,
    actionDue: loaded.due,
  };
  /** What the console derives from the fields: Save enabled, and the unsaved-edits flag. */
  const unsaved = (fields: ActionFields, record: { description: string; due: string }) => ({
    saveEnabled: fields.editDescription.trim() !== record.description || fields.editDue !== record.due,
    dirty:
      fields.editDescription.trim() !== record.description ||
      fields.editDue !== record.due ||
      fields.actionDescription !== record.description ||
      fields.actionDue !== record.due,
  });

  it('Tasks-tab completion creates "Call Friday": the editor follows, Save is disabled and stale text is never re-sent', () => {
    const next = { description: 'Call Friday', due: '2026-10-16' };
    const fields = rebaseActionFields(untouched, loaded, next);
    expect(fields).toEqual({
      editDescription: 'Call Friday',
      editDue: '2026-10-16',
      actionDescription: 'Call Friday',
      actionDue: '2026-10-16',
    });
    expect(unsaved(fields, next)).toEqual({ saveEnabled: false, dirty: false });
    expect(JSON.stringify(fields)).not.toContain('Review enquiry');
  });

  it('keeps a field the founder typed into and follows the ones they did not touch', () => {
    const next = { description: 'Call Friday', due: '2026-10-16' };
    const typed = { ...untouched, editDescription: 'Chase the quote' };
    const fields = rebaseActionFields(typed, loaded, next);
    expect(fields.editDescription).toBe('Chase the quote');
    expect(fields.editDue).toBe('2026-10-16');
    expect(fields.actionDescription).toBe('Call Friday');
    expect(unsaved(fields, next).saveEnabled).toBe(true);
  });

  it("a stage-form follow-up the founder typed survives saving the header's next action", () => {
    // The founder typed a follow-up in the stage form, then saved the header editor: the saved value becomes the record's.
    const saved = { description: 'Send contract', due: '2026-10-15' };
    const fields = rebaseActionFields(
      { editDescription: 'Send contract', editDue: '2026-10-15', actionDescription: 'Book demo', actionDue: '2026-10-20' },
      loaded,
      saved,
    );
    expect(fields.actionDescription).toBe('Book demo');
    expect(fields.actionDue).toBe('2026-10-20');
    expect(unsaved(fields, saved)).toEqual({ saveEnabled: false, dirty: true });
  });

  it('a change of the same record that changes nothing leaves every field as it is', () => {
    expect(rebaseActionFields(untouched, loaded, loaded)).toEqual(untouched);
  });

  it('whitespace-only edits do not enable Save', () => {
    const fields = { ...untouched, editDescription: 'Review enquiry  ' };
    expect(unsaved(fields, loaded)).toEqual({ saveEnabled: false, dirty: false });
  });

  it('followRecord reads as an updater: typed text wins over the record, untouched text follows it', () => {
    expect(followRecord('a', 'a', 'b')).toBe('b');
    expect(followRecord('typed', 'a', 'b')).toBe('typed');
  });
});

describe('what Discard puts back', () => {
  it('uses the record as it is now and its revision, so a save made while the question was open is not undone', () => {
    const before = { opportunity: { ...toDetail(records.A!).opportunity, id: 'A', revision: 1 } };
    const saved = {
      opportunity: {
        ...before.opportunity,
        revision: 2,
        nextAction: { description: 'Send the term sheet', dueAt: '2026-10-21T09:00:00Z' },
      },
    };
    expect(formAfterDiscard(before, String).base).toEqual({ id: 'A', revision: 1 });
    const after = formAfterDiscard(saved, String);
    expect(after.base).toEqual({ id: 'A', revision: 2 });
    expect(after.actionDescription).toBe('Send the term sheet');
    expect(after.editDescription).toBe('Send the term sheet');
    expect(after.editDue).toBe(after.actionDue);
  });
});
