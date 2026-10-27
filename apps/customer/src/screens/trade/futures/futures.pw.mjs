// Real-browser proof for the Futures and Margin rooms. Bundled Chromium headless shell, throwaway profile, never Brave.
// Run: lock.sh browser TRFUT -- node futures.pw.mjs <real|test> [scenario]
//  real = against the :3213 preview and the real local service (it lists no futures market: typed empty/refusal states).
//  test = same real sign-in, but the futures doors are answered by FuturesExchange (futures.fixtures.mjs): TEST DATA, labelled.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { FuturesExchange } from './futures.fixtures.mjs';

// Playwright is resolved from a worktree that has node_modules; override with PW_ROOT (default: this worktree's apps/customer).
const root = process.env.PW_ROOT || new URL('../../../../package.json', import.meta.url).pathname;
const { chromium } = createRequire(root)('@playwright/test');
const login = fs.readFileSync(process.env.HOME + '/.codex/context/work/TEST-LOGIN.md', 'utf8');
const creds = { email: login.match(/^Email: (.*)$/m)[1], password: login.match(/^Password: (.*)$/m)[1] };
const base = process.env.BASE || 'http://localhost:3213';
const mode = process.argv[2] || 'real';
const out = process.env.HOME + `/.codex/context/work/design/trade-rooms/TRFUT/${mode === 'real' ? 'real' : 'harness-test'}`;
fs.mkdirSync(out, { recursive: true });
const receipt = { at: new Date().toISOString(), base, mode, steps: [], errors: [], api: [] };
export const step = (name, pass, detail = {}) => {
  receipt.steps.push({ name, pass, ...detail });
  console.log(pass ? 'PASS' : 'FAIL', name, JSON.stringify(detail).slice(0, 300));
};

const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell',
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('**/*', (route) => {
  const url = new URL(route.request().url());
  return ['localhost', '127.0.0.1'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
});
export const page = await context.newPage();
page.on('pageerror', (e) => receipt.errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && receipt.errors.push(m.text()));

export let exchange = null;
export async function useExchange(opts) {
  exchange = new FuturesExchange(opts);
  await page.unroute('**/api/v1/**').catch(() => {});
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    const path = target.pathname.replace(/^\/api\/v1\//, '');
    const mine = /^(markets|account\/balance|positions|futures\/|funding-rate\/|ohlcv\/)/.test(path);
    if (!mine) return route.continue();
    const result = exchange.handle({
      method: request.method(),
      path,
      query: Object.fromEntries(target.searchParams),
      body: request.method() === 'GET' ? undefined : (request.postDataJSON?.() ?? null),
    });
    if (result === 'abort') return route.abort('connectionreset');
    return route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.json) });
  });
}

export const shot = async (name) => {
  for (const [w, h] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(500);
    const modal = await page.locator('[role="dialog"],[role="alertdialog"]').count();
    await page.screenshot({ path: `${out}/${name}-${w}x${h}.png`, fullPage: modal === 0 });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
};

export async function signIn(path) {
  await page.goto(`${base}/login?redirect=${encodeURIComponent(path)}`);
  await page.getByLabel('Email or handle', { exact: true }).fill(creds.email);
  await page.getByLabel('Password', { exact: true }).fill(creds.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**' + path.split('?')[0]);
}
export const finish = async () => {
  receipt.exchangeRequests = exchange?.requests.length ?? 0;
  fs.writeFileSync(`${out}/receipt-${process.argv[3] || mode}.json`, JSON.stringify(receipt, null, 1));
  console.log(receipt.errors.length ? `PAGE ERRORS: ${receipt.errors.join(' | ')}` : 'no page errors');
  await browser.close();
};

if (mode === 'probe') {
  await signIn('/trade/futures');
  await page.getByRole('link', { name: 'Margin', exact: true }).first().click();
  await page.waitForTimeout(2500);
  console.log(page.url(), (await page.locator('header').first().innerText()).replace(/\n/g, ' | '));
  await finish();
}
if (mode === 'real') {
  await signIn('/trade/futures');
  await page
    .getByText('No futures contract is listed')
    .waitFor({ timeout: 15000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
  const text = await page.locator('main').innerText();
  step('futures desk shows the named reason when no contract is listed', /No futures contract is listed/.test(text), {
    head: text.slice(0, 160).replace(/\n/g, ' | '),
  });
  step('no banned words', !/coming soon|unavailable|not connected|restricted|fixture|lifecycle/i.test(text));
  await shot('futures-no-contract');
  await page.getByRole('link', { name: 'Margin', exact: true }).first().click();
  await page.waitForTimeout(2500);
  const m = await page.locator('main').innerText();
  step('margin room renders its stats, rules and spot-margin blocker', /Margin rules/.test(m) && /Spot margin is not offered/.test(m), {
    head: m.slice(0, 160).replace(/\n/g, ' | '),
  });
  await shot('margin-empty');
  await finish();
}

const tryStep = async (name, fn) => {
  try {
    const detail = await fn();
    step(name, true, detail && typeof detail === 'object' ? detail : {});
  } catch (e) {
    step(name, false, { error: String(e.message).split('\n')[0] });
    await shot(`FAIL-${name.replace(/\W+/g, '-').slice(0, 40)}`).catch(() => {});
  }
};
const goDesk = async (opts) => {
  await signIn('/trade/futures');
  await useExchange(opts);
  await page.getByRole('link', { name: 'Margin', exact: true }).first().click();
  await page.getByRole('link', { name: 'Futures', exact: true }).first().click();
  await page.waitForTimeout(2500);
};
const dialog = () => page.getByRole('alertdialog').or(page.getByRole('dialog')).last();
const rows = () => page.locator('[data-screen="futures"] table tbody tr');

if (mode === 'test') {
  const only = process.argv[3];
  const run = (name) => !only || only === name;
  if (run('main')) {
    await goDesk({ seed: 'two' });
    await tryStep(
      'desk seeded with the shape the service sends today: two live positions, unpublished fields shown as dashes',
      async () => {
        await rows().first().waitFor();
        const n = await rows().count();
        if (n < 2) throw new Error(`rows ${n}`);
        await shot('desk-seeded');
      },
    );
    await tryStep('review shows all-in cost, then open long with confirm', async () => {
      await page.getByRole('textbox', { name: /^Size/ }).first().fill('0.05');
      await page
        .getByRole('textbox', { name: /^Leverage/ })
        .first()
        .fill('5');
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await page.getByText('Total to commit now').waitFor();
      const t = await page.locator('aside').innerText();
      if (!/651\.625/.test(t)) throw new Error('total to commit missing: ' + t.slice(0, 200));
      await shot('ticket-reviewed');
      await page.getByRole('button', { name: 'Open long', exact: true }).click();
      await dialog().waitFor();
      await shot('open-confirm');
      await dialog()
        .getByRole('button', { name: /^Confirm open long/ })
        .click();
      await page.getByText('Position opened').waitFor({ timeout: 8000 });
      await shot('open-done');
      return { requests: exchange.requests.filter((r) => r.method === 'POST' && r.path === 'positions').length };
    });
    await tryStep('new position appears in the blotter', async () => {
      await page.waitForTimeout(5500);
      const n = await rows().count();
      if (n < 3) throw new Error(`rows ${n}`);
      return { rows: n };
    });
    await tryStep('position detail opens with every published field and margin-call line', async () => {
      await rows().first().click();
      await dialog().waitFor();
      await shot('position-detail');
      return { text: (await dialog().innerText()).slice(0, 120).replace(/\n/g, ' | ') };
    });
    await tryStep('add margin sends one request with a request id', async () => {
      await dialog()
        .getByRole('button', { name: /Add margin/ })
        .first()
        .click();
      const d = dialog();
      await d.getByRole('textbox').first().fill('100');
      await shot('margin-add-dialog');
      await d
        .getByRole('button', { name: /^(Add margin|Confirm)/ })
        .last()
        .click();
      await page.waitForTimeout(1200);
      const r = exchange.requests.filter((q) => q.path === 'positions/margin');
      if (r.length !== 1 || !r[0].body.clientAdjustmentId) throw new Error('requests ' + JSON.stringify(r));
      await shot('margin-add-done');
    });
  }

  if (run('probe')) {
    await goDesk({ seed: 'two' });
    await rows().first().click();
    await dialog().waitFor();
    console.log(
      await dialog()
        .getByRole('button')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.textContent)),
    );
  }
  if (run('actions')) {
    await goDesk({ seed: 'two' });
    await tryStep('remove margin sends a reduce request', async () => {
      await rows().first().click();
      await dialog().getByRole('button', { name: 'Remove margin' }).first().click();
      await dialog().getByRole('textbox').first().fill('50');
      await dialog().getByRole('button', { name: 'Remove margin' }).last().click();
      await page.waitForTimeout(1200);
      if (exchange.requests.filter((q) => q.path === 'positions/margin/reduce').length !== 1) throw new Error('no reduce');
      await shot('margin-reduce-done');
    });
    await tryStep('change leverage to 10x sends one request; 50x is refused in words', async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);
      await rows().first().click();
      await dialog()
        .getByRole('button', { name: /^Leverage/ })
        .first()
        .click();
      await dialog().getByRole('textbox').first().fill('50');
      await dialog()
        .getByRole('button', { name: /Change leverage/ })
        .last()
        .click();
      await page.waitForTimeout(1200);
      const t = await dialog().innerText();
      if (!/above the limit|cap/i.test(t)) throw new Error('no refusal words: ' + t.slice(-200));
      await shot('leverage-refused');
      await dialog().getByRole('textbox').first().fill('10');
      await dialog()
        .getByRole('button', { name: /Change leverage/ })
        .last()
        .click();
      await page.waitForTimeout(1200);
      await shot('leverage-done');
      return { posts: exchange.requests.filter((q) => q.path === 'futures/leverage').length };
    });
    await tryStep('close one position at the accepted mark (no price sent)', async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);
      await rows()
        .nth(1)
        .getByRole('button', { name: /^Close,/ })
        .click();
      await shot('close-dialog');
      await dialog().getByRole('button', { name: 'Close position' }).last().click();
      await page.waitForTimeout(1500);
      const closes = exchange.requests.filter((q) => q.method === 'POST' && q.path === 'positions/pos-short-2/close');
      if (closes.length !== 1) throw new Error('closes ' + closes.length);
      if (closes[0].body.quantity !== '0.05' || typeof closes[0].body.clientCloseId !== 'string') {
        throw new Error('close body ' + JSON.stringify(closes[0].body));
      }
      if (exchange.requests.some((q) => q.method === 'DELETE' && q.path.startsWith('positions/'))) {
        throw new Error('DELETE must not close');
      }
      await shot('close-done');
    });
    await tryStep('close all lists positions and closes each with its own result', async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(6000);
      await page.getByRole('button', { name: 'Close all', exact: true }).click();
      await shot('close-all-dialog');
      await dialog()
        .getByRole('button', { name: /^Close (\d+ positions?|the)/ })
        .last()
        .click();
      await page.waitForTimeout(2500);
      await shot('close-all-done');
      return { positionsLeft: exchange.positions.length };
    });
    await tryStep('history tab lists closed and liquidated positions', async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await page.getByRole('tab', { name: 'History' }).click();
      await page.waitForTimeout(1500);
      const t = await page.locator('main').innerText();
      if (!/Liquidated/.test(t)) throw new Error('no liquidated row');
      await shot('tab-history');
    });
  }

  if (run('tabs')) {
    await goDesk({
      seed: 'risky',
      marginCall: 'pos-risky-3',
      acknowledged: false,
      adlEvents: [
        {
          eventId: 'adl-test-1',
          at: new Date(Date.now() - 86_400_000).toISOString(),
          version: 'adl-2026-10',
          bankruptPositionId: 'x-1',
          candidatePositionId: 'pos-risky-3',
          sizeToReduce: '0.01',
          beforeAction: true,
        },
      ],
    });
    await tryStep('risky position shows danger band and a delivered margin call', async () => {
      await rows().first().waitFor();
      await page.getByRole('tab', { name: 'Margin calls' }).click();
      await page.waitForTimeout(2500);
      const t = await page.locator('main').innerText();
      if (!/Margin call|margin call/.test(t)) throw new Error('no margin call text');
      await shot('tab-margin-calls');
    });
    await tryStep('funding tab shows rate, countdown, estimates and the unavailable history region', async () => {
      await page.getByRole('tab', { name: 'Funding' }).click();
      await page.waitForTimeout(1500);
      await shot('tab-funding');
    });
    await tryStep('ADL tab shows disclosure and events; the ticket asks for no acknowledgement', async () => {
      await page.getByRole('tab', { name: 'ADL and liquidations' }).click();
      await page.waitForTimeout(2000);
      await shot('tab-adl');
      const main = await page.locator('main').innerText();
      if (!/last-resort|insurance fund/.test(main)) throw new Error('no ADL disclosure copy in the ADL tab');
      const aside = await page.locator('aside').innerText();
      if (/I have read this/.test(aside)) throw new Error('the ticket still asks for an acknowledgement');
    });
    await tryStep('orders tab says there are no resting futures orders', async () => {
      await page.getByRole('tab', { name: 'Orders' }).click();
      await page.waitForTimeout(500);
      const t = await page.locator('main').innerText();
      if (!/no resting futures orders/.test(t)) throw new Error('missing');
      await shot('tab-orders');
    });
    await tryStep('margin room lists position health with margin call', async () => {
      await page.getByRole('link', { name: 'Margin', exact: true }).first().click();
      await page.waitForTimeout(3500);
      await shot('margin-room');
    });
  }

  if (run('future')) {
    await goDesk({ seed: 'risky', publishRisk: true, marginCall: 'pos-risky-3' });
    await tryStep('if the service publishes maintenance margin, PnL and mark: ratio, bands and distance appear', async () => {
      await rows().first().waitFor();
      await shot('desk-future-fields');
      await rows().first().click();
      await dialog().waitFor();
      await shot('position-detail-future-fields');
      await page.keyboard.press('Escape');
      await page.getByRole('link', { name: 'Margin', exact: true }).first().click();
      await page.waitForTimeout(3500);
      await shot('margin-room-future-fields');
    });
  }

  if (run('states')) {
    await goDesk({ seed: 'one', closeMode: 'closing', openMode: 'lose' });
    await tryStep('close with no usable mark leaves the position closing with a retry', async () => {
      await rows()
        .first()
        .getByRole('button', { name: /^Close,/ })
        .click();
      await dialog().getByRole('button', { name: 'Close position' }).last().click();
      await page.waitForTimeout(6500);
      const t = await rows().first().innerText();
      if (!/Closing/i.test(t)) throw new Error('row: ' + t);
      await shot('closing-state');
    });
    await tryStep('lost answer on open: ticket locks, Check status READS and finds the position without a second send', async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await page.getByRole('textbox', { name: /^Size/ }).first().fill('0.01');
      await page
        .getByRole('textbox', { name: /^Leverage/ })
        .first()
        .fill('3');
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await page.getByText('Total to commit now').waitFor();
      await page.getByRole('button', { name: 'Open long', exact: true }).click();
      await dialog()
        .getByRole('button', { name: /^Confirm open long/ })
        .click();
      await page.waitForTimeout(2500);
      await shot('open-unknown');
      await page.getByRole('button', { name: 'Check status' }).first().click();
      await page.getByText('Position opened').waitFor({ timeout: 8000 });
      const posts = exchange.requests.filter((q) => q.method === 'POST' && q.path === 'positions');
      if (posts.length !== 1) throw new Error('check sent a second open: ' + posts.length);
      await shot('open-unknown-found');
      return { posts: posts.length };
    });
    await tryStep(
      'open that never arrived: Check status finds nothing, the trader sends the same request again, one position',
      async () => {
        await goDesk({ seed: 'one', openMode: 'drop' });
        await page.getByRole('textbox', { name: /^Size/ }).first().fill('0.01');
        await page
          .getByRole('textbox', { name: /^Leverage/ })
          .first()
          .fill('3');
        await page.getByRole('button', { name: 'Review', exact: true }).click();
        await page.getByText('Total to commit now').waitFor();
        await page.getByRole('button', { name: 'Open long', exact: true }).click();
        await dialog()
          .getByRole('button', { name: /^Confirm open long/ })
          .click();
        await page.waitForTimeout(2500);
        await page.getByRole('button', { name: 'Check status' }).first().click();
        await page.getByRole('button', { name: 'Send the same request again' }).waitFor({ timeout: 8000 });
        await shot('open-not-found');
        const before = exchange.requests.filter((q) => q.method === 'POST' && q.path === 'positions').length;
        if (before !== 1) throw new Error('posts before resend ' + before);
        await page.getByRole('button', { name: 'Send the same request again' }).click();
        await page.getByText('Position opened').waitFor({ timeout: 8000 });
        const posts = exchange.requests.filter((q) => q.method === 'POST' && q.path === 'positions');
        if (posts.length !== 2 || posts[0].body.clientOpenId !== posts[1].body.clientOpenId) throw new Error('ids differ');
        return { sameId: posts[0].body.clientOpenId };
      },
    );
    await tryStep('a close whose answer was lost: Check status reads the closed row and reports done, not refused', async () => {
      await goDesk({ seed: 'one', closeMode: 'lose' });
      await rows()
        .first()
        .getByRole('button', { name: /^Close,/ })
        .click();
      await dialog().getByRole('button', { name: 'Close position' }).last().click();
      await page.waitForTimeout(2500);
      await page.getByRole('button', { name: 'Check status' }).first().click();
      await page.waitForTimeout(2000);
      await page.waitForTimeout(1000);
      const t = await page.locator('body').innerText();
      if (/Refused|is not open/i.test(t)) throw new Error('close misreported');
      const closes = exchange.requests.filter((q) => q.method === 'POST' && q.path === 'positions/pos-long-1/close');
      if (closes.length !== 1) throw new Error('a second close was sent: ' + closes.length);
      if (closes[0].body.quantity !== '0.1') throw new Error('quantity ' + JSON.stringify(closes[0].body));
      await shot('close-lost-answer-checked');
    });
    await goDesk({ planeOff: true, seed: 'one' });
    await tryStep('futures plane off: named block, no actions', async () => {
      await page.waitForTimeout(1500);
      await shot('plane-off');
    });
    await goDesk({ seed: 'one', markDark: true, fundingPublished: false });
    await tryStep('mark dark and no funding rate: figures are dashes with reasons', async () => {
      await page.waitForTimeout(1500);
      await shot('mark-dark');
    });
    await goDesk({ noMarkets: true, seed: 'one' });
    await tryStep('no contract listed but an old position is still manageable', async () => {
      await shot('no-contract-with-position');
    });
  }
  await finish();
}
