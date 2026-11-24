// Records, from `@intafaced/telemetry`'s `Metrics` (packages/telemetry/src/metrics.ts), what `service_kit::metrics` is
// held to byte for byte: `tests/fixtures/metrics.golden.json`, each case's observations and the exposition
// `Metrics.render` wrote for them, and `statusClass` and `methodLabel` over their edges.
//
// Run from the repository root:
//   node --import tsx crates/service-kit/scripts/record-metrics.mjs          writes the file
//   node --import tsx crates/service-kit/scripts/record-metrics.mjs --check  fails when it is stale

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire as requireFrom } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const prettier = requireFrom(`${ROOT}package.json`)('prettier');
const OUT = fileURLToPath(new URL('../tests/fixtures/metrics.golden.json', import.meta.url));
const { Metrics, statusClass, methodLabel, MODULE_LOCAL } = await import(pathToFileURL(`${ROOT}packages/telemetry/src/metrics.ts`).href);

const L = (over = {}) => ({ service: 'svc-ledger', module: MODULE_LOCAL, method: 'GET', status: '2xx', outcome: 'none', ...over });

// A fixed generator, so the long case is the same every run.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function long() {
  const rand = lcg(3600);
  const sets = [L(), L({ method: 'POST' }), L({ method: 'POST', status: '4xx' }), L({ method: 'HEAD' }), L({ status: '5xx' })];
  const out = [];
  for (let i = 0; i < 600; i += 1) {
    const set = sets[Math.floor(rand() * sets.length)];
    const scale = [1e-4, 1e-3, 1e-2, 1e-1, 1, 10][Math.floor(rand() * 6)];
    out.push([set, rand() * scale * 3]);
  }
  return out;
}

const NUL = String.fromCharCode(0);

const cases = [
  { name: 'empty', maxSeries: 2000, observations: [] },
  {
    name: 'every bucket edge',
    maxSeries: 2000,
    observations: [0.0012, 0.005, 0.0050001, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 10.000001, 11, 1e9].map((s) => [L(), s]),
  },
  {
    name: 'sums as JavaScript adds them',
    maxSeries: 2000,
    observations: [0.1, 0.2, 0.3, 1e-7, 0.7].map((s) => [L({ method: 'POST' }), s]),
  },
  {
    name: 'broken clocks count as zero',
    maxSeries: 2000,
    observations: [-1, -0, 0, Number.NaN, Infinity, -Infinity].map((s) => [L({ status: '5xx' }), s]),
  },
  {
    name: 'tiny durations in exponent form',
    maxSeries: 2000,
    observations: [1e-7, 1e-9, 5e-324, 2.5e-8].map((s) => [L(), s]),
  },
  {
    name: 'label values escape backslash, quote and line feed only',
    maxSeries: 2000,
    observations: [
      [L({ service: 'a\\b"c\nd\te' + String.fromCodePoint(0xe9, 0x1f600), module: '\\\\', outcome: '"' }), 0.001],
      [L({ method: '_other', status: '\n' }), 0.002],
    ],
  },
  {
    name: 'label sets whose joined keys meet are one series',
    maxSeries: 2000,
    observations: [
      [L({ service: `a${NUL}b`, module: 'c' }), 0.001],
      [L({ service: 'a', module: `b${NUL}c` }), 0.002],
    ],
  },
  {
    name: 'past the cap, one constant overflow series',
    maxSeries: 2,
    observations: [
      [L({ service: 'svc-a' }), 0.01],
      [L({ service: 'svc-b' }), 0.02],
      [L({ service: 'svc-c', method: 'PUT', status: '4xx' }), 0.03],
      [L({ service: 'svc-d', module: 'pay', method: 'DELETE', status: '5xx', outcome: 'refused' }), 0.04],
      [L({ service: 'svc-a' }), 0.05],
      [L({ service: 'svc-b' }), 6],
      [L({ service: 'svc-e' }), 0.07],
    ],
  },
  {
    name: 'a cap of zero',
    maxSeries: 0,
    observations: [
      [L(), 0.01],
      [L({ method: 'POST' }), 0.02],
    ],
  },
  { name: 'six hundred requests', maxSeries: 2000, observations: long() },
];

const num = (n) => (Object.is(n, -0) ? '-0' : String(n));
const golden = {
  cases: cases.map((c) => {
    const m = new Metrics(c.maxSeries);
    for (const [labels, s] of c.observations) m.observe(labels, s);
    return {
      name: c.name,
      maxSeries: c.maxSeries,
      observations: c.observations.map(([labels, s]) => ({ labels, seconds: num(s) })),
      size: m.size(),
      render: m.render(),
    };
  }),
  statusClass: [0, 1, 99, 100, 101, 199, 200, 204, 299, 300, 304, 399, 400, 404, 499, 500, 503, 599, 600, 999, 65535].map((n) => [
    n,
    statusClass(n),
  ]),
  methodLabel: [
    'GET',
    'get',
    'Head',
    'POST',
    'put',
    'PATCH',
    'delete',
    'OPTIONS',
    'TRACE',
    'CONNECT',
    'PROPFIND',
    '',
    'GET ',
    String.fromCodePoint(0xfb06),
  ].map((m) => [m, methodLabel(m)]),
};

// Written as the repository's formatter writes JSON, so the commit hook's format check and `--check` agree.
const text = await prettier.format(JSON.stringify(golden), { ...(await prettier.resolveConfig(OUT)), filepath: OUT });
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {}
  if (current !== text) {
    console.error(`stale: ${OUT}; run without --check`);
    process.exit(1);
  }
  console.log('metrics.golden.json is current');
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
