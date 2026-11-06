// World: none
// DIAG #7215 (never merged): poll the futures preview's mark for 3 minutes and dump the books and the maker's log on the
// first null mark.
import { readFileSync } from 'node:fs';
import { test } from './journey.mjs';
import { EDGE, ORIGIN, api, fund, stackFile } from './stack.mjs';
import { signUp, verify } from './desk.mjs';

test('DIAG7215 mark watch', async ({ page }) => {
  test.setTimeout(300_000);
  const who = await signUp(page, 'dg');
  await verify(page, who);
  fund(who.email, 'USDT', '1000');
  const me = await api(who);
  const until = Date.now() + 180_000;
  let polls = 0;
  let nulls = 0;
  while (Date.now() < until) {
    polls += 1;
    const p = await me.post('/api/v1/positions/preview', { symbol: 'BTC/USDT:USDT', side: 'long', size: '0.01', leverage: '5' });
    if (p.body?.markPrice == null || p.body?.slippageCapBps == null) {
      nulls += 1;
      if (nulls <= 3) {
        console.log('DIAG7215 null mark at', new Date().toISOString(), JSON.stringify(p.body).slice(0, 600));
        for (const sym of ['BTC/USDT', 'BTC/USDT:USDT']) {
          const b = await fetch(`${EDGE}/api/v1/orderbook/${encodeURIComponent(sym)}?limit=5`, { headers: { origin: ORIGIN } }).then((r) =>
            r.text(),
          );
          console.log('DIAG7215 book', sym, b.slice(0, 1500));
        }
        console.log('DIAG7215 market.log\n' + readFileSync(stackFile('logs/market.log'), 'utf8').split('\n').slice(-40).join('\n'));
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`DIAG7215 polls ${polls}, null marks ${nulls}`);
});
