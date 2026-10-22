import { describe, expect, it } from 'vitest';
import { requireAnotherAdmin } from './org-service.js';

describe('requireAnotherAdmin (the one last-admin rule)', () => {
  it('refuses the only admin leaving', () => {
    expect(() => requireAnotherAdmin(['a'], 'a')).toThrow(expect.objectContaining({ code: 'org.last_admin' }));
  });
  it('allows an admin leaving while another remains, and a non-admin leaving', () => {
    expect(() => requireAnotherAdmin(['a', 'b'], 'a')).not.toThrow();
    expect(() => requireAnotherAdmin(['a'], 'c')).not.toThrow();
  });
});
