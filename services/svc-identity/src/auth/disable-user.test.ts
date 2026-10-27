import { describe, expect, it } from 'vitest';
import { AuthError } from './auth-service.js';
import { disableUser, installDisabledMintRefuse, requireDisableUserId } from './disable-user.js';
import { ACTION_APPROVAL_MISSING, stubActionApprovals } from './privileged-dual-control.js';
import { DUAL_CONTROL_MISSING } from './four-eyes.js';

type UserRow = { id: string; status: string; archived?: boolean };
type KeyRow = { id: string; user_id: string; revoked: boolean };

function store(users: UserRow[], keys: KeyRow[]) {
  let writes = 0;
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('archived_at is not null')) {
      return users.filter((u) => u.id === values[0] && u.archived).map((u) => ({ id: u.id }));
    }
    if (text.includes('from users')) {
      const id = values[0];
      return users.filter((u) => u.id === id).map((u) => ({ id: u.id, status: u.status }));
    }
    if (text.includes('update users')) {
      writes += 1;
      const id = values[0];
      const out: Array<{ id: string }> = [];
      for (const u of users) {
        if (u.id === id && !u.archived) {
          u.status = 'frozen';
          out.push({ id: u.id });
        }
      }
      return out;
    }
    if (text.includes('update sessions')) {
      writes += 1;
      return [];
    }
    if (text.includes('update api_keys')) {
      writes += 1;
      const named = values[0];
      const out: Array<{ id: string }> = [];
      for (const k of keys) {
        if (k.user_id === named && k.revoked === false) {
          k.revoked = true;
          out.push({ id: k.id });
        }
      }
      return out;
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  return Object.assign(fn, {
    get writes() {
      return writes;
    },
    users,
    keys,
  }) as unknown as Parameters<typeof disableUser>[0] & { writes: number; users: UserRow[]; keys: KeyRow[] };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GHOST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const CONFIRM = '22222222-2222-4222-8222-222222222222';
const dual = { actorId: ACTOR, approvalId: 'appr-1', operationId: 'op-1', targetId: 'identity.disable_user' };
const approvals = stubActionApprovals(CONFIRM);

describe('disableUser', () => {
  it('refuses a missing userId and does not write', async () => {
    const sql = store([{ id: A, status: 'active' }], [{ id: 'k', user_id: A, revoked: false }]);
    await expect(disableUser(sql, undefined, dual, approvals)).rejects.toMatchObject({ code: 'auth.user_id_missing' });
    await expect(disableUser(sql, '', dual, approvals)).rejects.toMatchObject({ code: 'auth.user_id_missing' });
    await expect(disableUser(sql, '   ', dual, approvals)).rejects.toMatchObject({ code: 'auth.user_id_missing' });
    expect(() => requireDisableUserId(null)).toThrow(/userId is required/);
    expect(sql.writes).toBe(0);
    expect(sql.users[0]?.status).toBe('active');
    expect(sql.keys[0]?.revoked).toBe(false);
  });

  it('refuses a missing user and does not write', async () => {
    const sql = store([{ id: A, status: 'active' }], [{ id: 'k', user_id: A, revoked: false }]);
    await expect(disableUser(sql, GHOST, dual, approvals)).rejects.toMatchObject({ code: 'auth.not_found' });
    expect(sql.writes).toBe(0);
    expect(sql.users[0]?.status).toBe('active');
    expect(sql.keys[0]?.revoked).toBe(false);
  });

  it('refuses an archived record before the approval is spent, and does not write', async () => {
    const sql = store([{ id: A, status: 'closed', archived: true }], [{ id: 'k', user_id: A, revoked: false }]);
    let spent = 0;
    const counting = {
      consume: async (...args: Parameters<typeof approvals.consume>) => {
        spent += 1;
        return approvals.consume(...args);
      },
    };
    await expect(disableUser(sql, A, dual, counting)).rejects.toMatchObject({ code: 'identity.account_archived' });
    expect(spent).toBe(0);
    expect(sql.writes).toBe(0);
    expect(sql.users[0]?.status).toBe('closed');
  });

  it('freezes the named user and revokes only their live keys', async () => {
    const sql = store(
      [
        { id: A, status: 'active' },
        { id: B, status: 'active' },
      ],
      [
        { id: 'a-live', user_id: A, revoked: false },
        { id: 'a-dead', user_id: A, revoked: true },
        { id: 'b-live', user_id: B, revoked: false },
      ],
    );
    const out = await disableUser(sql, A, dual, approvals);
    expect(out).toEqual({ userId: A, status: 'frozen', keysRevoked: 1 });
    expect(sql.users.find((u) => u.id === A)?.status).toBe('frozen');
    expect(sql.users.find((u) => u.id === B)?.status).toBe('active');
    expect(sql.keys.find((k) => k.id === 'a-live')?.revoked).toBe(true);
    expect(sql.keys.find((k) => k.id === 'a-dead')?.revoked).toBe(true);
    expect(sql.keys.find((k) => k.id === 'b-live')?.revoked).toBe(false);
  });

  it('refuses a single actor and does not write', async () => {
    const sql = store([{ id: A, status: 'active' }], [{ id: 'k', user_id: A, revoked: false }]);
    await expect(disableUser(sql, A, { actorId: ACTOR, targetId: 'identity.disable_user' }, approvals)).rejects.toMatchObject({
      code: ACTION_APPROVAL_MISSING,
    });
    await expect(
      disableUser(sql, A, { actorId: ACTOR, confirmActorId: ACTOR, targetId: 'identity.disable_user' }, approvals),
    ).rejects.toMatchObject({
      code: ACTION_APPROVAL_MISSING,
    });
    expect(sql.writes).toBe(0);
    expect(sql.users[0]?.status).toBe('active');
    expect(sql.keys[0]?.revoked).toBe(false);
  });
});

describe('installDisabledMintRefuse', () => {
  it('refuses mint when the user is frozen; lets an active user through', async () => {
    const sql = store(
      [
        { id: A, status: 'frozen' },
        { id: B, status: 'active' },
      ],
      [],
    );
    let minted = 0;
    const auth = {
      async createApiKey(_input: { userId: string }) {
        minted += 1;
        return { id: 'k', key: 'ifc', prefix: 'ifc', mode: 'live' as const };
      },
    };
    installDisabledMintRefuse(auth as never, sql);
    await expect(auth.createApiKey({ userId: A } as never)).rejects.toBeInstanceOf(AuthError);
    await expect(auth.createApiKey({ userId: A } as never)).rejects.toMatchObject({ code: 'auth.account_frozen' });
    expect(minted).toBe(0);
    await expect(auth.createApiKey({ userId: B } as never)).resolves.toMatchObject({ id: 'k' });
    expect(minted).toBe(1);
  });
});
