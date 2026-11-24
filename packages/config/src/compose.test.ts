import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from './compose.js';

const COMPOSE = [
  'services:',
  '  svc-a:',
  '    environment:',
  '      A_FLAG: ${A_FLAG:-off}',
  '',
  '  # svc-b holds the Zone setting',
  '  svc-b:',
  '    image: b',
  '    environment:',
  '      ZONE: ${ZONE:-}',
  '',
  'volumes:',
  '  b-data:',
  '',
].join('\n');

describe('composeServiceBlock', () => {
  it('slices one service and stops at a comment at the services indent', () => {
    expect(composeServiceBlock(COMPOSE, 'svc-a')).toBe('  svc-a:\n    environment:\n      A_FLAG: ${A_FLAG:-off}\n');
  });

  it('ends the last service at a top-level key, never running on into volumes', () => {
    const block = composeServiceBlock(COMPOSE, 'svc-b');
    expect(block).toContain('ZONE: ${ZONE:-}');
    expect(block).not.toContain('volumes:');
    expect(block).not.toContain('b-data');
  });

  it('ends a service that is last in the text at the end of the text', () => {
    const text = 'services:\n  svc-z:\n    image: z\n    environment:\n      Z_FLAG: on';
    expect(composeServiceBlock(text, 'svc-z')).toBe('  svc-z:\n    image: z\n    environment:\n      Z_FLAG: on');
  });

  it('keeps a deeper line that starts with Z, and ends at a column-0 line', () => {
    const text = 'services:\n  svc-z:\n    environment:\n      ZONE: a\nZ_TOP: b\n';
    expect(composeServiceBlock(text, 'svc-z')).toBe('  svc-z:\n    environment:\n      ZONE: a\n');
  });

  it('matches the whole name only, never a longer service that starts with it', () => {
    const text = 'services:\n  svc-a-worker:\n    image: w\n  svc-a:\n    image: a\n';
    expect(composeServiceBlock(text, 'svc-a')).toBe('  svc-a:\n    image: a\n');
  });

  it('refuses a missing service by name', () => {
    expect(() => composeServiceBlock(COMPOSE, 'svc-x')).toThrow('svc-x service block missing from the compose file');
  });

  it('the hand-written \\Z slice it replaces never ended a last service (the old fault)', () => {
    const text = 'services:\n  svc-z:\n    image: z\n    environment:\n      Z_FLAG: on\n';
    // The copied pattern, built from strings so it is not a new copy: `\Z` in a JavaScript regex is a literal Z, so the
    // end-of-file branch never matched.
    const copied = new RegExp('^  svc-z:' + '\\n(?:.*\\n)*?(?=^  [a-z]|\\Z)', 'm');
    const oldSlice = text.match(copied);
    expect(oldSlice).toBeNull();
    expect(composeServiceBlock(text, 'svc-z')).toContain('Z_FLAG: on');
  });
});
