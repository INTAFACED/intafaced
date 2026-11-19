import { describe, expect, it } from 'vitest';
import { isLibraryDeskOp, LIBRARY_DESK_OPS, NOT_LISTED } from './model';

describe('strategy library desk proxy list (J-algo-dev-10 #6)', () => {
  it('passes on the five listed actions and nothing else', () => {
    expect(LIBRARY_DESK_OPS).toEqual(['hide', 'unhide', 'remove', 'dispute-open', 'dispute-resolve']);
    for (const op of LIBRARY_DESK_OPS) expect(isLibraryDeskOp(op)).toBe(true);
    for (const op of ['delete', 'purge', 'queue', 'ops.library.hide', '', null, undefined, 1, ['hide']])
      expect(isLibraryDeskOp(op)).toBe(false);
    expect(NOT_LISTED).toMatchObject({ ok: false, code: 'admin.action_not_listed', changed: 'no' });
  });
});
