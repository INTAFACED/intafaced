/**
 * ONE PAGE ON THE DEMO WORLD, set up the same way for `pnpm shots` (tooling/shots/shots.mjs) and for the look gate's
 * venue-on rooms (tooling/ci/look-gate/look-gate.mjs): the clock at the recording's time, every /api call answered by
 * the demo world (index.mjs) or refused, no socket, and signed in, the seeded trader's TEST browser wallet reading its
 * network from the demo chain (chain.mjs) on a loopback node. So the pictures a person judges and the pictures the gate
 * judges are drawn on one world, with the venue on as the beta runs it.
 */
import http from 'node:http';
import { installTestWallet } from '../real-app/test-wallet.mjs';
import { demoChain } from './chain.mjs';
import { DEMO_NOW, demoAnswer } from './index.mjs';
import { demoWalletKey } from './seed.mjs';

/** The key rooms, each signed out or in: what `pnpm shots` draws and the look gate judges venue-on. */
export const DEMO_ROOMS = [
  { path: '/', signedIn: false },
  { path: '/home', signedIn: true },
  { path: '/trade', signedIn: false },
  { path: '/trade', signedIn: true },
  { path: '/trade/spot/PURR-USDC', signedIn: true },
  { path: '/trade/futures', signedIn: true },
  { path: '/money', signedIn: true },
  { path: '/uc/recharge', signedIn: true },
  { path: '/verification', signedIn: true },
  { path: '/trade/convert', signedIn: true },
];

/** The venue's network, which the seeded trader's browser wallet is on (null when the recording names none). */
export const DEMO_CHAIN_ID = demoAnswer('http://x/api/v1/venue/status', 'GET', null, { signedIn: true })?.json?.chainId ?? null;

const NO_SESSION = { error: { message: 'No session.', code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: 401 } } };

/**
 * The demo chain's node on loopback (an ephemeral port), where the TEST wallet reads its network: the wallet reads from
 * outside the page, so a page route can't answer it. `{ url, close }`.
 */
export function startDemoNode() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let call;
      try {
        call = JSON.parse(body);
      } catch {
        return void res.writeHead(400).end();
      }
      const answer = demoChain(call.method, call.params, { chainId: DEMO_CHAIN_ID, now: DEMO_NOW });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...answer }));
    });
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () =>
      ok({ url: `http://127.0.0.1:${server.address().port}/demo-node`, close: () => new Promise((done) => server.close(done)) }),
    );
  });
}

/**
 * Sets `page` on the demo world before it opens a room: the frozen clock, the answers, and signed in, the TEST wallet on
 * `node` (startDemoNode's url). A call the world has no answer for is passed to `onUnanswered` and refused with
 * `refusal`; signed out, the session check is refused as identity refuses it with no session (401), so the app draws its
 * signed-out page instead of waiting on an answer that never comes.
 */
export async function prepareDemoPage(page, { signedIn, node, refusal, onUnanswered = () => {} }) {
  await page.clock.setFixedTime(new Date(DEMO_NOW));
  await page.route('**/api/**', (route) => {
    const r = route.request();
    const answer = demoAnswer(r.url(), r.method(), r.postData(), { signedIn, now: DEMO_NOW });
    if (answer) return route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.json) });
    if (!signedIn && r.url().includes('/api/identity/trpc/auth.refresh'))
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify(NO_SESSION) });
    onUnanswered(`${r.method()} ${new URL(r.url()).pathname}`);
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(refusal) });
  });
  await page.routeWebSocket(/\/ws(\/|$)/, (ws) => ws.close({ code: 1011, reason: refusal.code }));
  if (signedIn && DEMO_CHAIN_ID && node)
    await installTestWallet(page, { chainId: DEMO_CHAIN_ID, privateKey: demoWalletKey(), rpcUrl: node });
}

/** Signed in, once the room has loaded: connects the TEST wallet where the room asks, as the seeded trader would. */
export async function connectDemoWallet(page, { signedIn }) {
  if (!signedIn) return;
  const connect = page.getByRole('button', { name: 'Connect TEST Wallet' }).first();
  const asked = await connect.waitFor({ state: 'visible', timeout: 5_000 }).then(
    () => true,
    () => false,
  );
  if (!asked) return;
  await connect.click();
  const sheet = page.getByRole('button', { name: 'Continue in wallet' });
  if (await sheet.isVisible({ timeout: 1500 }).catch(() => false)) await sheet.click();
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}
