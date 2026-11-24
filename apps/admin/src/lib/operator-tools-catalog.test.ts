import { describe, expect, it } from 'vitest';
import { ACADEMY_ADMIN_COURSES } from '@intafaced/contracts/academy-admin-procedures';
import { toolOf } from './operator-tools-catalog';

describe('toolOf', () => {
  it("gives a tool the edge module, path and kind of its call's record, unchanged", () => {
    expect(toolOf(ACADEMY_ADMIN_COURSES)).toEqual({ edgeModule: 'academy', procedure: 'admin.courses', kind: 'query' });
  });
});
