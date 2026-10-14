// External file on purpose: the policy has script-src 'self' and no inline script.
const ports = { configured: 18080, bare: 18081, academyConfigured: 18085, academyBare: 18086 };
const here = new URL(location.href);
const host = here.hostname === '127.0.0.1' ? 'localhost' : here.hostname;
const origin = (kind) => `http://${host}:${kind === 'configured' ? (here.port || ports.configured) : ports.bare}`;
// This page is served by the "configured" copy; the bare copy is always the next port up.
ports.configured = Number(here.port) || ports.configured;
ports.bare = ports.configured + 1;
ports.academyConfigured = ports.configured + 5;
ports.academyBare = ports.configured + 6;
const base = (kind) => `http://${host}:${ports[kind]}`;
document.getElementById('link-configured').href = base('configured') + '/login';
document.getElementById('link-bare').href = base('bare') + '/login';
document.getElementById('link-academy').href = base('academyConfigured') + '/login';
document.getElementById('link-academy-bare').href = base('academyBare') + '/login';
for (const a of document.querySelectorAll('a[data-app]')) a.href = base(a.dataset.app) + a.dataset.path;
void origin;

const rows = document.getElementById('rows');
const count = document.getElementById('count');
const status = document.getElementById('status');
const cell = (text) => {
  const td = document.createElement('td');
  td.textContent = text ?? '';
  return td;
};
async function refresh() {
  try {
    const res = await fetch('/__csp-preview/violations', { cache: 'no-store' });
    const data = await res.json();
    count.textContent = String(data.count);
    rows.replaceChildren();
    if (!data.count) {
      const tr = document.createElement('tr');
      const td = cell('None yet.');
      td.colSpan = 5;
      tr.append(td);
      rows.append(tr);
    }
    for (const v of data.violations.slice().reverse()) {
      const tr = document.createElement('tr');
      tr.append(cell(new Date(v.at).toLocaleTimeString()), cell(v.directive), cell(v.blocked), cell(v.document), cell(v.source ? `${v.source}:${v.line ?? ''}` : ''));
      rows.append(tr);
    }
    status.textContent = '';
  } catch {
    status.textContent = 'Could not read the violation list.';
  }
}
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('clear').addEventListener('click', async () => {
  await fetch('/__csp-preview/clear', { method: 'POST' });
  refresh();
});
refresh();
setInterval(refresh, 2500);
