/**
 * Every port a compose file publishes binds the host's loopback, 127.0.0.1 (#9168). Docker writes its own iptables
 * rules, which skip a host firewall, so a port published with no host IP is open to the network on any hosted server:
 * Postgres, Redis, NATS, the observability stack and the operator console all were. The one exception is the customer
 * site's web entry point (vendor-shell), which serves the site and proxies its API and stream same-origin.
 *
 * Read line by line, with no YAML library and no Docker: a `ports:` key followed by an inline list or by `- ` items.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
/** Services allowed to publish beyond loopback: the web entry point alone. */
const WEB_ENTRY = new Set(['vendor-shell']);

/** `[{ service, mapping }]` for every published port in a compose file's text. */
export function publishedPorts(text) {
  const out = [];
  let service = null;
  let inServices = false;
  let listIndent = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (/^[A-Za-z]/.test(line)) inServices = false;
    if (!inServices || !line.trim() || /^\s*#/.test(raw)) continue;
    const svc = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (svc) {
      service = svc[1];
      listIndent = null;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (listIndent !== null) {
      const item = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (item && indent >= listIndent) {
        out.push({ service, mapping: unquote(item[1]) });
        continue;
      }
      listIndent = null;
    }
    const ports = /^(\s+)ports:\s*(.*)$/.exec(line);
    if (!ports) continue;
    const rest = ports[2].trim();
    if (rest.startsWith('[')) {
      for (const m of rest.replace(/^\[|\]$/g, '').split(',')) if (m.trim()) out.push({ service, mapping: unquote(m) });
    } else if (rest === '') {
      listIndent = ports[1].length;
    } else {
      out.push({ service, mapping: `unreadable: ${rest}` });
    }
  }
  return out;
}

const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, '');

/** A mapping that names 127.0.0.1 as its host IP (short syntax `127.0.0.1:host:container`). */
export const bindsLoopback = (mapping) => mapping.startsWith('127.0.0.1:');

const composeFiles = readdirSync(ROOT).filter((f) => /^docker-compose.*\.ya?ml$/.test(f));

test('the repo has compose files to read, and they publish ports', () => {
  assert.ok(composeFiles.includes('docker-compose.yml'), 'docker-compose.yml is missing');
  const all = composeFiles.flatMap((f) => publishedPorts(readFileSync(join(ROOT, f), 'utf8')));
  assert.ok(all.length > 0, 'no published ports were parsed: fix the parser rather than trusting the green');
  assert.ok(
    all.some((p) => WEB_ENTRY.has(p.service)),
    'the web entry point was not found: fix the parser or WEB_ENTRY',
  );
});

for (const file of composeFiles) {
  test(`${file}: every published port binds 127.0.0.1, except the web entry point`, () => {
    const open = publishedPorts(readFileSync(join(ROOT, file), 'utf8')).filter(
      (p) => !WEB_ENTRY.has(p.service) && !bindsLoopback(p.mapping),
    );
    assert.deepEqual(
      open.map((p) => `${p.service} ${p.mapping}`),
      [],
      `${file}: these ports listen on every interface, which Docker opens past a host firewall. Write them as ` +
        `'127.0.0.1:<host>:<container>' (#9168).`,
    );
  });
}

test('the parser reads both list forms and catches an unbound port', () => {
  const text = [
    'services:',
    '  db:',
    '    image: x',
    '    ports:',
    "      - '${PG:-5433}:5432' # comment",
    "      - '127.0.0.1:6380:6379'",
    '    volumes:',
    '      - data:/data',
    '  api:',
    "    ports: ['127.0.0.1:4000:4000', '4014:4014']",
    'volumes:',
    '  data:',
  ].join('\n');
  const ports = publishedPorts(text);
  assert.deepEqual(ports, [
    { service: 'db', mapping: '${PG:-5433}:5432' },
    { service: 'db', mapping: '127.0.0.1:6380:6379' },
    { service: 'api', mapping: '127.0.0.1:4000:4000' },
    { service: 'api', mapping: '4014:4014' },
  ]);
  assert.deepEqual(
    ports.filter((p) => !bindsLoopback(p.mapping)).map((p) => p.mapping),
    ['${PG:-5433}:5432', '4014:4014'],
  );
});
