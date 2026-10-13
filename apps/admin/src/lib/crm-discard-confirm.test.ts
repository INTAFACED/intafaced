import { describe, expect, it } from 'vitest';
import { createDiscardConfirm, type DiscardQuestion } from './crm-discard-confirm';

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
});
