import { describe, expect, it } from 'vitest';
import { NOTE_MAX, noteProblem } from './note-model';

describe('noteProblem', () => {
  it('lets ordinary text through', () => {
    expect(noteProblem('Rent for October', undefined)).toBeNull();
    expect(noteProblem('  padded  ', undefined)).toBeNull();
  });
  it('refuses nothing but spaces', () => {
    expect(noteProblem('   ', undefined)).toBe('empty');
  });
  it('refuses a control character, which the service refuses too', () => {
    expect(noteProblem('line\nbreak', undefined)).toBe('control');
  });
  it('stops at the service limit', () => {
    expect(noteProblem('a'.repeat(NOTE_MAX), undefined)).toBeNull();
    expect(noteProblem('a'.repeat(NOTE_MAX + 1), undefined)).toBe('tooLong');
  });
  it('does not resend the note that is already saved', () => {
    expect(noteProblem('same ', 'same')).toBe('unchanged');
  });
});
