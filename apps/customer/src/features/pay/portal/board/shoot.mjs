// Usage: node shoot.mjs [--port=4658] [--only=money,payments] [--out=<dir>]
// Shoots every board route at 1440, the priority routes at 390, and the pages that differ by role as finance and
// viewer. Writes index.html with a section per package and a "Not live" table. TEST data throughout.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allRoutes, go, launch, openPortal, parseArgs, startServer } from './harness.mjs';

const args = parseArgs(process.argv.slice(2));
const OUT =
  args.out ?? '/private/tmp/claude-502/-Users-Nitro-projects-Sovereign/624de872-c2b7-4498-b5aa-50f7598cd5ab/scratchpad/shots/portal-final';
/** Pages that read differently by role: shot again as finance and as viewer. */
const BY_ROLE = new Set(['P06', 'P26', 'P31', 'P57', 'P05', 'P13', 'P39']);
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const routes = allRoutes().filter((r) => !args.only || args.only.includes(r.pkg));
const server = await startServer(args.port);
let browser;
const results = [];
try {
  browser = await launch();
  const jobs = [];
  for (const r of routes) {
    jobs.push({ ...r, width: 1440, tag: '1440', who: r.who });
    if (r.phone) jobs.push({ ...r, width: 390, tag: '390', who: r.who });
    if (BY_ROLE.has(r.id) && r.who === 'owner')
      for (const who of ['finance', 'viewer', 'none']) jobs.push({ ...r, width: 1440, tag: `1440-${who}`, who });
  }
  // One signed-in session per (person, width): navigating in-app keeps the sign-in.
  const sessions = new Map();
  for (const job of jobs) {
    const key = `${job.who}:${job.width}`;
    if (!sessions.has(key))
      sessions.set(key, await openPortal(browser, server.url, { who: job.who, width: job.width, height: job.width < 700 ? 844 : 900 }));
    const { page, mock } = sessions.get(key);
    const before = mock.unmounted.length;
    await go(page, job.path);
    const dir = join(OUT, job.pkg);
    mkdirSync(dir, { recursive: true });
    const file = `${job.id}-${slug(job.title)}-${job.tag}.png`;
    await page.screenshot({ path: join(dir, file), fullPage: true });
    const soon = await page.$$eval('.pfo-soon', (cards) =>
      cards.map((c) => ({ title: c.querySelector('.pfo-soon-reason')?.textContent ?? '', needs: c.getAttribute('data-needs') ?? '' })),
    );
    const missing = [...new Set(mock.unmounted.slice(before))].filter((p) => p !== 'merchant.myAccess');
    const final = await page.evaluate(() => location.pathname);
    results.push({ ...job, file: `${job.pkg}/${file}`, soon, missing, final });
    process.stdout.write(`${job.pkg} ${job.id} ${job.tag}${soon.length ? ` (not live x${soon.length})` : ''}\n`);
  }
  for (const s of sessions.values()) await s.context.close();
} finally {
  await browser?.close();
  server.stop();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const section = (pkg) => {
  const rows = results.filter((r) => r.pkg === pkg);
  return `<section><h2>${esc(pkg)}</h2><div class="grid">${rows
    .map(
      (r) =>
        `<figure><a href="${esc(r.file)}"><img loading="lazy" src="${esc(r.file)}" alt="${esc(r.id + ' ' + r.title)}"></a><figcaption>${esc(r.id)} · ${esc(r.title)} · ${esc(r.tag)} <code>${esc(r.path)}</code></figcaption></figure>`,
    )
    .join('')}</div></section>`;
};
const soonRows = results
  .filter((r) => r.soon.length && r.tag === '1440')
  .map(
    (r) =>
      `<tr><td>${esc(r.id)} ${esc(r.title)}</td><td>${esc(r.soon.map((s) => s.title || 'section').join(', '))}</td><td>${esc([...r.soon.map((s) => s.needs).filter(Boolean), ...r.missing].join('; '))}</td></tr>`,
  )
  .join('');
writeFileSync(
  join(OUT, 'index.html'),
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Portal board</title>
<style>body{font:14px system-ui;margin:24px;background:#0b0b0c;color:#eee}h1,h2{font-weight:500}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}figure{margin:0}img{width:100%;border:1px solid #333;border-radius:6px}code{color:#aaa}table{border-collapse:collapse}td,th{border:1px solid #333;padding:6px 10px;text-align:left}</style>
<h1>Merchant portal board</h1><p>TEST data from a stand-in. Nothing here is a real merchant or amount.</p>
${['money', 'payments', 'settings'].map(section).join('')}
<section><h2>Not live</h2><table><tr><th>Page</th><th>Reason shown</th><th>What it waits for</th></tr>${soonRows}</table></section>`,
);
console.log(`Wrote ${join(OUT, 'index.html')} (${results.length} shots)`);
