// A journey's one TEST person who holds their own money: an account, a TEST browser wallet key, and, once a step has set
// one up, an authenticator. The journeys on the launch money model (the venue holds the trading money, the partner the
// spending money, the person's wallet the rest) share these: the person read from the journey's run state, the next
// authenticator code that run has not used, their own API through Edge, and svc-bank's procedures on that API.
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { expect } from './journey.mjs';
import { ROOT, api, toUnits } from './stack.mjs';
import { nextCode } from './identity-factors.mjs';

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/**
 * The run's person, from its journey state: `who` (the account) and `walletKey`, with the wallet's address as `owner`.
 * A step that finds none fails naming the step that makes them, never acting as someone else.
 */
export function walletPerson(run, first) {
  const s = run.read();
  if (!s.who || !s.walletKey) throw new Error(`${first} made no account and wallet, so this step has no one to act as`);
  return { ...s, owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}

/** The next authenticator code once the run keeps a `secret`, keeping its `step` so no code is used twice; none before. */
export async function nextRunCode(run) {
  const s = run.read();
  if (!s.secret) return undefined;
  const { totp } = await totpLib();
  const { code, step } = await nextCode(totp, s.secret, s.step);
  run.write({ step });
  return code;
}

/** The person's own API through Edge, signed in with the run's next code once there is an authenticator. */
export async function personApi(run, first) {
  const totpCode = await nextRunCode(run);
  return api(walletPerson(run, first).who, totpCode ? { totpCode } : {});
}

/** svc-bank's tRPC procedures on one API session (`api()`'s answer): a query and a mutation, each answer checked 200. */
export function bankOn(session) {
  return {
    async query(procedure, input) {
      const q = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
      const res = await (await session()).get(`/api/bank/trpc/${procedure}${q}`);
      expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
      return res.body.result.data;
    },
    async mutate(procedure, input) {
      const res = await (await session()).post(`/api/bank/trpc/${procedure}`, input);
      expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
      return res.body.result.data;
    },
  };
}

/** The first number a room draws ("65,000.10", "60.12 USDC", "$1.20", "−3.5"), as scaled units. */
export function numberShown(text) {
  const found = /[+−-]?[\d,]+(\.\d+)?/.exec(text.replace(/\$/g, ''));
  if (!found) throw new Error(`no number in "${text}"`);
  return toUnits(found[0].replace(/,/g, '').replace('−', '-').replace('+', ''));
}
