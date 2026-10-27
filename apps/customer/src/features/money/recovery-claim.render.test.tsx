// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoveryClaimMessage } from '@intafaced/contracts/identity-recovery';
import { makeRecoveryKey, readRecoveryKey, signWithRecoveryKey } from '../account/recovery-keys';
import { refusalCodes } from './RecoveryClaim';

// TEST data only. The heir's claim room (RC-identity-08, J-identity-05 #7): what `bank.recovery.estates` answers decides
// the room; each pasted key signs the claim text in the browser, and only after the text is checked to name this account,
// this person and this claim. Only public halves and signatures are sent.
const HEIR = '72222222-2222-4222-8222-222222222222';
const OWNER = '71111111-1111-4111-8111-111111111111';
const CLAIM = '76666666-6666-4666-8666-666666666666';
const SPACE = '73333333-3333-4333-8333-333333333333';
const world = vi.hoisted(() => ({
  estates: null as unknown,
  mutate: [] as unknown[],
  asked: [] as Array<{ kind: string; procedure: string; input: unknown }>,
}));
const api = {
  query: (_service: string, procedure: string, input: unknown) => {
    world.asked.push({ kind: 'query', procedure, input });
    return Promise.resolve(world.estates);
  },
  mutate: (_service: string, procedure: string, input: unknown) => {
    world.asked.push({ kind: 'mutate', procedure, input });
    return Promise.resolve(world.mutate.shift());
  },
};
vi.mock('../session/session', () => ({ useSession: () => ({ userId: HEIR, api }) }));

import { RecoveryClaim } from './RecoveryClaim';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;

const free = (assetId: string, amount: string, space?: { id: string; name: string }) => ({
  ownerType: space ? 'subaccount' : 'user',
  assetId,
  kind: 'available',
  spaceId: space?.id ?? null,
  spaceName: space?.name ?? null,
  amount,
});
const estate = (over: Record<string, unknown> = {}) => ({
  userId: OWNER,
  handle: 'owner_test',
  threshold: 2,
  liveKeys: 3,
  claim: null,
  sweepable: [free('BTC', '0.02'), free('USDT', '125', { id: SPACE, name: 'Holiday' })],
  held: [],
  blockers: [],
  ...over,
});
const openAnswer = (message = recoveryClaimMessage({ userId: OWNER, heirUserId: HEIR, claimId: CLAIM })) => ({
  ok: true,
  data: {
    claimId: CLAIM,
    status: 'open',
    round: 0,
    createdAt: '2026-10-25T01:00:00.000Z',
    executedAt: null,
    ownerUserId: OWNER,
    handle: 'owner_test',
    threshold: 2,
    liveKeys: 3,
    message,
  },
});

const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
// Signing runs on the platform's crypto, which answers on its own schedule: wait for what the step leads to (up to 5 s).
async function settleUntil(done: () => boolean) {
  for (const started = Date.now(); !done() && Date.now() - started < 5000;) await settle();
}
async function show(list: unknown) {
  world.estates = { ok: true, data: { estates: list } };
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<RecoveryClaim />));
  await settle();
}
const valueOf = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
async function paste(index: number, text: string) {
  const box = host.querySelectorAll<HTMLTextAreaElement>('textarea')[index]!;
  await act(async () => {
    valueOf.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const submit = () => act(async () => host.querySelector<HTMLFormElement>('[data-testid="recovery-claim-form"]')!.requestSubmit());
const mutations = () => world.asked.filter((a) => a.kind === 'mutate');

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.asked = [];
  world.mutate = [];
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('the recovery claim room', () => {
  it('with no account naming the person says so, and offers nothing to sign', async () => {
    await show([]);
    expect(world.asked[0]).toMatchObject({ kind: 'query', procedure: 'recovery.estates' });
    expect(host.textContent).toContain('No account names you to receive it.');
    expect(host.textContent).toContain('Staff never hold a key and cannot move these balances.');
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('lists the account, what moves from its main account and spaces, and one box per key it needs', async () => {
    await show([estate()]);
    expect(host.textContent).toContain('Account of @owner_test');
    expect(host.textContent).toContain('2 of their 3 live keys must sign.');
    expect(host.textContent).toContain('No claim started.');
    const moving = host.querySelector('[data-testid="recovery-sweepable"]')!.textContent;
    expect(moving).toContain('Main account');
    expect(moving).toContain('Space “Holiday”');
    expect(moving).toContain('0.02 BTC');
    expect(host.textContent).toContain('Nothing is held.');
    expect(host.querySelectorAll('textarea')).toHaveLength(2);
  });

  it('signs the checked claim text with each key and sends only public halves and signatures', async () => {
    const [one, two] = [await makeRecoveryKey(), await makeRecoveryKey()];
    await show([estate()]);
    await paste(0, one.text);
    await paste(1, `  ${two.text}\n`);
    world.mutate = [
      openAnswer(),
      {
        ok: true,
        data: {
          claim: {
            claimId: CLAIM,
            status: 'executed',
            round: 0,
            createdAt: '2026-10-25T01:00:00.000Z',
            executedAt: '2026-10-25T01:00:01.000Z',
          },
          round: 0,
          sweeps: [
            {
              round: 0,
              ownerType: 'user',
              spaceId: null,
              assetId: 'BTC',
              amount: '0.02',
              status: 'posted',
              ledgerTxId: 'tx-1',
              refusalCode: null,
            },
            {
              round: 0,
              ownerType: 'subaccount',
              spaceId: SPACE,
              assetId: 'USDT',
              amount: '125',
              status: 'posted',
              ledgerTxId: 'tx-2',
              refusalCode: null,
            },
          ],
        },
      },
    ];
    await submit();
    await settleUntil(() => Boolean(host.querySelector('[data-testid="recovery-moved"]')));
    const [open, execute] = mutations();
    expect(open).toMatchObject({ procedure: 'recovery.claims.open', input: { ownerUserId: OWNER } });
    expect(execute!.procedure).toBe('recovery.claims.execute');
    const sent = execute!.input as { claimId: string; signatures: Array<{ publicKey: JsonWebKey; signature: string }> };
    expect(sent.claimId).toBe(CLAIM);
    expect(JSON.stringify(sent)).not.toContain('"d"');
    expect(sent.signatures.map((s) => s.publicKey)).toEqual([one.publicKey, two.publicKey]);
    const message = new TextEncoder().encode(recoveryClaimMessage({ userId: OWNER, heirUserId: HEIR, claimId: CLAIM }));
    for (const { publicKey, signature } of sent.signatures) {
      expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
      const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const raw = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, message)).toBe(true);
    }
    const moved = host.querySelector('[data-testid="recovery-moved"]')!.textContent;
    expect(moved).toContain('Moved to your main account:');
    expect(moved).toContain('125 USDT');
    expect(moved).toContain('Space “Holiday”');
  });

  it('signs nothing when the claim text does not name this account, this person and this claim', async () => {
    const [one, two] = [await makeRecoveryKey(), await makeRecoveryKey()];
    await show([estate()]);
    await paste(0, one.text);
    await paste(1, two.text);
    world.mutate = [openAnswer(recoveryClaimMessage({ userId: OWNER, heirUserId: OWNER, claimId: CLAIM }))];
    await submit();
    await settleUntil(() => Boolean(host.querySelector('[role="alert"]')));
    expect(host.textContent).toContain('The claim text did not name this account');
    expect(mutations().map((m) => m.procedure)).toEqual(['recovery.claims.open']);
  });

  it('names a bad, empty or repeated key before asking the bank anything', async () => {
    const one = await makeRecoveryKey();
    await show([estate({ threshold: 3 })]);
    await paste(0, 'INTAFACED-RECOVERY-KEY-1.not-a-key');
    await paste(1, one.text);
    await submit();
    expect(host.textContent).toContain('This is not a recovery key.');
    expect(host.textContent).toContain('Paste a key here, or remove this box.');
    await paste(0, one.text);
    await paste(2, one.text);
    await submit();
    expect(host.textContent).toContain('This key is pasted twice.');
    expect(mutations()).toHaveLength(0);
  });

  it('says why the keys did not claim the account, with identity’s reference', async () => {
    const [one, two] = [await makeRecoveryKey(), await makeRecoveryKey()];
    await show([estate()]);
    await paste(0, one.text);
    await paste(1, two.text);
    world.mutate = [
      openAnswer(),
      {
        ok: false,
        reason: 'refused',
        status: 412,
        code: 'PRECONDITION_FAILED',
        message: 'The recovery keys did not claim this account [identity.recovery_signatures_short]',
      },
    ];
    await submit();
    await settleUntil(() => Boolean(host.querySelector('[role="alert"]')));
    const alert = host.querySelector('[role="alert"]')!.textContent;
    expect(alert).toContain('Not enough of their live keys signed.');
    expect(alert).toContain('Reference: identity.recovery_signatures_short');
  });

  it('lists held value that stays behind, and still lets the free value move', async () => {
    await show([estate({ held: [{ ...free('USDT', '40'), kind: 'hold' }] })]);
    expect(host.querySelector('[data-testid="recovery-held"]')!.textContent).toContain('40 USDT');
    expect(host.querySelector('[data-testid="recovery-debts"]')).toBeNull();
    expect(host.querySelector('[data-testid="recovery-claim-form"] button[type="submit"]')).not.toBeNull();
  });

  it('shows a debt and keeps the claim refused until it is settled', async () => {
    await show([estate({ blockers: [free('USDT', '-40')] })]);
    expect(host.querySelector('[data-testid="recovery-debts"]')!.textContent).toContain('-40 USDT');
    expect(host.textContent).toContain('Their account owes a debt, so the claim cannot move anything until it is settled.');
    expect(host.querySelector('[data-testid="recovery-claim-form"] button[type="submit"]')).toBeNull();
  });

  it('says nothing moved when every sweep of the round was refused', async () => {
    const [one, two] = [await makeRecoveryKey(), await makeRecoveryKey()];
    await show([estate()]);
    await paste(0, one.text);
    await paste(1, two.text);
    world.mutate = [
      openAnswer(),
      {
        ok: true,
        data: {
          claim: { claimId: CLAIM, status: 'open', round: 1, createdAt: '2026-10-25T01:00:00.000Z', executedAt: null },
          round: 0,
          sweeps: [
            {
              round: 0,
              ownerType: 'user',
              spaceId: null,
              assetId: 'BTC',
              amount: '0.02',
              status: 'refused',
              ledgerTxId: null,
              refusalCode: 'frozen',
            },
          ],
        },
      },
    ];
    await submit();
    await settleUntil(() => Boolean(host.querySelector('[data-testid="recovery-moved"]')));
    const result = host.querySelector('[data-testid="recovery-moved"]')!.textContent;
    expect(result).toContain('Nothing moved this time:');
    expect(result).not.toContain('Moved to your main account:');
    expect(result).toContain('Refused (frozen)');
  });
});

describe('recovery claim helpers', () => {
  it('reads a key text back to the same public half, and refuses anything else', async () => {
    const made = await makeRecoveryKey();
    expect(readRecoveryKey(`\n${made.text} `)?.publicKey).toEqual(made.publicKey);
    expect(readRecoveryKey(made.text.slice(1))).toBeNull();
    expect(readRecoveryKey('INTAFACED-RECOVERY-KEY-1.')).toBeNull();
    expect(readRecoveryKey(`INTAFACED-RECOVERY-KEY-1.${btoa(JSON.stringify({ d: 'a', x: 'b', y: 'c' }))}`)).toBeNull();
    const signed = await signWithRecoveryKey(readRecoveryKey(made.text)!, 'hello');
    expect(signed.publicKey).toEqual(made.publicKey);
    expect(signed.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  it('finds the bank’s and identity’s codes in a refusal', () => {
    expect(refusalCodes({ code: 'PRECONDITION_FAILED', message: 'x [identity.recovery_key_revoked]' })).toEqual([
      'identity.recovery_key_revoked',
    ]);
    expect(refusalCodes({ code: 'bank.recovery_blocked', message: 'held (USDT held) [bank.recovery_blocked]' })).toEqual([
      'bank.recovery_blocked',
      'bank.recovery_blocked',
    ]);
  });
});
