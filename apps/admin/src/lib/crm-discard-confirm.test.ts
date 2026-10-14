import { describe, expect, it } from 'vitest';
import { createDiscardConfirm, keepEditingBeforeSave, type DiscardQuestion } from './crm-discard-confirm';

function setup() {
  const seen: Array<DiscardQuestion | null> = [];
  return { seen, confirm: createDiscardConfirm((question) => seen.push(question)) };
}

describe('in-page discard question', () => {
  it('shows the question, then resolves true on Discard and clears the bar', async () => {
    const { seen, confirm } = setup();
    const answer = confirm.ask('Discard unsaved edits and reload this enquiry?');
    expect(confirm.pending()).toBe(true);
    expect(seen[0]?.prompt).toBe('Discard unsaved edits and reload this enquiry?');
    confirm.answer(true);
    await expect(answer).resolves.toBe(true);
    expect(confirm.pending()).toBe(false);
    expect(seen.at(-1)).toBeNull();
  });
  it('resolves false on Keep editing', async () => {
    const { confirm } = setup();
    const answer = confirm.ask('Discard?');
    confirm.answer(false);
    await expect(answer).resolves.toBe(false);
  });
  it('treats a question replaced by a newer one as "keep editing", never as a discard', async () => {
    const { seen, confirm } = setup();
    const first = confirm.ask('first');
    const second = confirm.ask('second');
    await expect(first).resolves.toBe(false);
    expect(confirm.pending()).toBe(true);
    expect(seen.at(-1)?.prompt).toBe('second');
    confirm.answer(true);
    await expect(second).resolves.toBe(true);
  });
  it('ignores an answer when nothing is asked', () => {
    const { seen, confirm } = setup();
    confirm.answer(true);
    expect(seen).toEqual([]);
  });
  it('answers a pending question as "keep editing" when a save starts, so a late Discard cannot reset the form from an old record', async () => {
    const { seen, confirm } = setup();
    let discarded = false;
    const leave = confirm.ask('Discard unsaved changes and open another enquiry?').then((discard) => {
      if (discard) discarded = true;
      return discard;
    });
    expect(keepEditingBeforeSave(confirm)).toBe(true);
    await expect(leave).resolves.toBe(false);
    expect(confirm.pending()).toBe(false);
    expect(seen.at(-1)).toBeNull();
    // The Discard button is gone with the bar; a stray answer is ignored and nothing is discarded.
    confirm.answer(true);
    expect(discarded).toBe(false);
  });
  it('does nothing when a save starts and no question is open', () => {
    const { seen, confirm } = setup();
    expect(keepEditingBeforeSave(confirm)).toBe(false);
    expect(seen).toEqual([]);
  });
});
