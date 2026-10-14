import { describe, expect, it } from 'vitest';
import { nextEditorDirty, nextEditorOpen } from './crm-next-editor';

const record = { description: 'Send the deck', dueAt: '2026-10-16T09:00:00.000Z' };
const local = (iso: string) => iso.slice(0, 16);

describe('collapsed next-action editor', () => {
  it('is closed until the founder opens it', () => {
    expect(nextEditorOpen(false, false)).toBe(false);
    expect(nextEditorOpen(true, false)).toBe(true);
  });
  it('opens by itself when it holds an unsaved or restored edit, so a draft is never hidden', () => {
    expect(nextEditorOpen(false, true)).toBe(true);
    expect(nextEditorDirty(record, { description: 'Send the updated deck', due: '2026-10-16T09:00' }, local)).toBe(true);
    expect(nextEditorDirty(record, { description: 'Send the deck', due: '2026-10-17T09:00' }, local)).toBe(true);
  });
  it('stays closed while the fields match the record (ignoring stray spaces), and when there is no next action', () => {
    expect(nextEditorDirty(record, { description: '  Send the deck ', due: '2026-10-16T09:00' }, local)).toBe(false);
    expect(nextEditorDirty(null, { description: 'x', due: 'y' }, local)).toBe(false);
  });
});
