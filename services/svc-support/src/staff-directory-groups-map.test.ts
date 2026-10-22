import { describe, expect, it } from 'vitest';
import { MemoryGroupBook } from './desk-groups.js';
import { MemoryStaffBook } from './desk-staff.js';
import { SupportService } from './support-service.js';

const LEAD = '33333333-3333-4333-8333-333333333333';
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';
const C = '66666666-6666-4666-8666-666666666666';
const AT = '2026-10-22T04:00:00.000Z';

describe('staff directory groups by user id (SP-agents-01 follow-up)', () => {
  it('matches the per-member filter for several members, shared groups and members in none', async () => {
    const staff = new MemoryStaffBook();
    const groups = new MemoryGroupBook();
    const support = new SupportService(undefined, undefined, undefined, staff, undefined, null, undefined, groups);
    for (const [userId, role] of [
      [LEAD, 'lead'],
      [A, 'agent'],
      [B, 'agent'],
      [C, 'agent'],
    ] as const) {
      await staff.appoint({ userId, role, by: LEAD, at: AT });
    }
    const ids: string[] = [];
    for (const name of ['Trading', 'Payments', 'Cards']) {
      const g = await groups.save({ name, by: LEAD, at: AT });
      ids.push(g!.id);
    }
    await groups.addMember({ groupId: ids[0]!, userId: A, by: LEAD, at: AT });
    await groups.addMember({ groupId: ids[1]!, userId: A, by: LEAD, at: AT });
    await groups.addMember({ groupId: ids[2]!, userId: A, by: LEAD, at: AT });
    await groups.addMember({ groupId: ids[0]!, userId: B, by: LEAD, at: AT });

    const all = await groups.list();
    const expected = (await support.listStaff()).map((m) => ({
      ...m,
      groups: all.filter((g) => g.memberIds.includes(m.userId)).map((g) => ({ id: g.id, name: g.name })),
    }));
    const got = await support.listStaffDirectory();
    expect(got).toEqual(expected);
    expect(got.find((m) => m.userId === A)?.groups.map((g) => g.name)).toEqual(['Cards', 'Payments', 'Trading']);
    expect(got.find((m) => m.userId === C)?.groups).toEqual([]);
    expect(got.find((m) => m.userId === LEAD)?.groups).toEqual([]);
  });
});
