// Records, from the TypeScript svc-academy in this checkout, what the Rust crate's curriculum slice is built from and
// held to:
//
// - `src/curriculum/spine.json`: the curriculum spine as `curriculum/catalog.ts` serves it, in its seed order, with each
//   item's body, objectives, key terms and self-check from `curriculum/content.ts`, byte for byte. `nameOrder` is the
//   spine sorted as `searchPublicCurriculum` sorts by name (`title.localeCompare(.., 'en') || slug.localeCompare(..)`),
//   so the Rust needs no collation tables.
// - `tests/fixtures/curriculum.golden.json`: what the TypeScript router answered (status and body, as the wire replay
//   masks them) to every curriculum call over a set of inputs, against a stand-in database whose rows each scenario
//   names, and what `GET /internal/curriculum` answered.
//
// Run from the repository root, with the workspace packages built (`pnpm --filter "@intafaced/svc-academy^..." build`):
//   TZ=UTC node --import tsx crates/svc-academy/scripts/record-curriculum.mjs          writes the files
//   TZ=UTC node --import tsx crates/svc-academy/scripts/record-curriculum.mjs --check  fails when a written file is stale
//
// It stops being runnable when the TypeScript service is deleted; from then on what it wrote is the reference, and a
// change to the spine is made in `spine.json` (with `nameOrder` kept in title order).

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CRATE = fileURLToPath(new URL('../', import.meta.url));
const SVC = `${ROOT}services/svc-academy/src/`;
const NAME = 'record-curriculum';
// The TypeScript service was deleted when svc-academy switched to this crate (weed project-state#3343): what this script
// wrote is now the reference, and a change to it is made in the recorded file itself. Read the TypeScript in git history.
if (!existsSync(SVC)) {
  console.error(
    `${NAME}: services/svc-academy no longer exists (the Rust crate replaced it); nothing to record from. The files it wrote are the reference now.`,
  );
  process.exit(2);
}
const CHECK = process.argv.includes('--check');

if (process.env.TZ !== 'UTC') {
  console.error('record-curriculum: run with TZ=UTC');
  process.exit(2);
}
// The wire replay's process: vitest sets NODE_ENV to `test`; the jurisdiction guard's switches are off.
process.env.INTAFACED_UNSIGNED_SANCTIONS_ROWS = 'off';
process.env.INTAFACED_SCREENING_FAIL_CLOSED = 'off';
process.env.APP_ENV = 'test';
process.env.NODE_ENV = 'test';

/** A package as the service resolves it: this script sits outside the service's `node_modules`. */
const fromService = createRequire(`${SVC}index.ts`);
const dep = (name) => import(pathToFileURL(fromService.resolve(name)).href);
const { default: Fastify } = await dep('fastify');
const { fastifyTRPCPlugin } = await dep('@trpc/server/adapters/fastify');
const { createEdgeContext, encodePrincipal, signPrincipalHeader, serviceAuthHeadersForBody } = await dep('@intafaced/contracts');
const { parseAmount } = await dep('@intafaced/ledger-client');
const { createAcademyRouter } = await import(`${SVC}router.ts`);
const { AcademyService } = await import(`${SVC}academy-service.ts`);
const { stubApprovalConsumer } = await import(`${SVC}action-approval-consume.ts`);
const { BaseHostRights } = await import(`${SVC}host-rights.ts`);
const { FixedStake } = await import(`${SVC}stake-source.ts`);
const { NullStreamProvider } = await import(`${SVC}stream/provider.ts`);
const { listCurriculum, getCurriculumItem } = await import(`${SVC}curriculum/catalog.ts`);
const { registerInternalCurriculumRoute } = await import(`${SVC}curriculum/internal-curriculum.ts`);

// ── The spine ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The seed order is the order `SPINE` holds: `listCurriculum` sorts, so read it back through the module's own map. */
const seedOrder = (() => {
  const src = readFileSync(`${SVC}curriculum/catalog.ts`, 'utf8');
  const seed = src.slice(src.indexOf('const SPINE_SEED'), src.indexOf('] as const;'));
  return [...seed.matchAll(/^\s{4}slug: '([a-z0-9-]+)',$/gm)].map((m) => m[1]);
})();
const listed = listCurriculum();
if (seedOrder.length !== listed.length || new Set(seedOrder).size !== listed.length) {
  throw new Error(`record-curriculum: read ${seedOrder.length} seed slugs, the catalog lists ${listed.length}`);
}
const items = seedOrder.map((slug) => {
  const item = getCurriculumItem(slug);
  if (!item) throw new Error(`record-curriculum: ${slug} is not in the catalog`);
  return {
    slug: item.slug,
    title: item.title,
    kind: item.kind,
    path: item.path,
    order: item.order,
    summary: item.summary,
    body: item.body,
    objectives: [...item.objectives],
    keyTerms: item.keyTerms.map((t) => ({ term: t.term, definition: t.definition })),
    selfCheck: [...item.selfCheck],
  };
});
const nameOrder = [...listed].sort((a, b) => a.title.localeCompare(b.title, 'en') || a.slug.localeCompare(b.slug)).map((r) => r.slug);
const spine = { items, nameOrder };

// ── The answers ──────────────────────────────────────────────────────────────────────────────────────────────────────

// The edge and service secrets sign this run's requests only and appear in no answer: a fresh one each run.
const SECRET = randomBytes(24).toString('hex');
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-academy' });

function headers(scoped) {
  if (!scoped) return { 'x-intafaced-region': 'DE' };
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['academy:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  });
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

/**
 * A stand-in database: each query, however it is built, resolves to the scenario's rows for the longest table name its
 * text holds, and to no rows otherwise; a transaction runs on the same stand-in. Every scenario is a state a real
 * `academy` schema can hold: `tests/curriculum_golden.rs` seeds a real Postgres with the same rows and asks the Rust.
 */
const ITEM = 'markets-reading-the-book';
const GRANT = { id: '33333333-3333-4333-8333-333333333333', user_id: USER, path_slug: 'markets', source: 'staff', reason: 'golden' };
const at = (iso) => new Date(iso);
const LESSON = { title: 'Position size', course_title: 'Risk basics', course_slug: 'risk-basics' };
const SCENARIOS = {
  empty: {},
  'featured-item': { featured_items: [{ item_slug: ITEM }] },
  'featured-item-gated': { featured_items: [{ item_slug: ITEM }], item_prerequisites: [{ prerequisite_slug: 'foundations-risk-first' }] },
  'featured-item-off-spine': { featured_items: [{ item_slug: 'gone-from-the-spine' }] },
  'lesson-published': { 'academy.course_items i': [{ ...LESSON, course_state: 'published' }] },
  'lesson-draft': { 'academy.course_items i': [{ ...LESSON, course_state: 'draft' }] },
  'prerequisite-met': {
    item_prerequisites: [{ prerequisite_slug: 'foundations-risk-first' }],
    cert_item_completions: [{ item_slug: 'foundations-risk-first' }],
  },
  'window-ahead': {
    item_windows: [{ available_from: at('2099-01-01T00:00:00Z'), available_until: at('2100-01-01T00:00:00Z'), due_at: null }],
  },
  'window-open': {
    item_windows: [{ available_from: at('2020-01-01T00:00:00Z'), available_until: at('2099-01-01T00:00:00Z'), due_at: null }],
  },
  'window-due-passed': {
    item_windows: [
      { available_from: at('2020-01-01T00:00:00Z'), available_until: at('2099-01-01T00:00:00Z'), due_at: at('2021-01-01T00:00:00Z') },
    ],
  },
  'course-starts-later': { course_starts: [{ starts_at: at('2099-06-01T00:00:00Z') }] },
  'course-started': { course_starts: [{ starts_at: at('2020-06-01T00:00:00Z') }] },
  'grant-revoked': { access_grants: [{ ...GRANT, starts_at: at('2020-01-01T00:00:00Z'), expires_at: null, state: 'revoked' }] },
  'grant-ended': {
    access_grants: [{ ...GRANT, starts_at: at('2020-01-01T00:00:00Z'), expires_at: at('2021-03-04T05:06:07.089Z'), state: 'granted' }],
    // The next event number of the grant, as `COALESCE(MAX(n), 0)::int + 1` answers with no events yet.
    access_grant_events: [{ n: 1 }],
  },
  'grant-open': {
    access_grants: [{ ...GRANT, starts_at: at('2020-01-01T00:00:00Z'), expires_at: at('2099-01-01T00:00:00Z'), state: 'granted' }],
  },
};

function standIn(rows) {
  const answer = (text) => {
    // The joined lesson query names featured_items too; it is told apart by its join.
    const key = Object.keys(rows)
      .sort((a, b) => b.length - a.length)
      .find((k) => text.includes(k) && (k !== 'featured_items' || !text.includes('academy.course_items i')));
    return key ? rows[key] : [];
  };
  let proxy;
  const handler = {
    apply: (_t, _this, args) => {
      const [strings] = args;
      if (Array.isArray(strings) && 'raw' in strings) return Promise.resolve(answer(strings.join('?')));
      return { helper: args };
    },
    get: (_t, key) => {
      if (key === 'begin') return (a, b) => (typeof a === 'function' ? a : b)(proxy);
      return new Proxy(() => undefined, handler);
    },
  };
  proxy = new Proxy(() => undefined, handler);
  return proxy;
}

async function serve(rows) {
  const academy = new AcademyService(standIn(rows), new FixedStake(parseAmount('0')), new BaseHostRights(), new NullStreamProvider(), {});
  const app = Fastify();
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: createAcademyRouter(academy, {}, undefined, stubApprovalConsumer('replay-operator')),
      createContext: ({ req }) => edgeContext(req),
    },
  });
  return app;
}

async function hit(app, path, input, scoped) {
  const url = `/trpc/${path}${input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  const res = await app.inject({ method: 'GET', url, headers: headers(scoped) });
  const body = res.body
    .replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"')
    .replace(/"requestId":"req-[0-9a-z]+"/g, '"requestId":"<id>"')
    .replaceAll(`"path":${JSON.stringify(path)}`, '"path":"<path>"');
  return `${res.statusCode} ${body}`;
}

const slugs = seedOrder;
const first = listed[0].slug;
const PATHS = ['foundations', 'markets', 'builder', 'sovereign'];
const KINDS = ['playbook', 'workbook', 'lesson'];

/** [path, scoped, input] for the empty database. */
const cases = [];
const add = (path, scoped, ...inputs) => {
  for (const input of inputs) cases.push([path, scoped, input]);
};

add(
  'curriculum',
  true,
  undefined,
  {},
  { limit: 200 },
  { limit: 3 },
  { limit: 1.7 },
  { limit: 0 },
  { limit: -1 },
  { limit: 0.5 },
  { limit: 1e9 },
);
for (const path of PATHS) add('curriculum', true, { path, limit: 50 });
for (const kind of KINDS) add('curriculum', true, { kind, limit: 50 }, { kind, path: 'builder', limit: 2 });
for (const slug of slugs) add('curriculumRelated', true, { slug, limit: 200 });
add(
  'curriculumRelated',
  true,
  { slug: first },
  { slug: first, limit: 1 },
  { slug: 'no-such-slug', limit: 2 },
  { slug: ` ${first} `, limit: 2 },
);
for (const slug of slugs) add('curriculumItem', true, { slug });
add('curriculumItem', true, { slug: ` ${first} ` }, { slug: 'no-such-slug' });
for (const slug of [first, slugs[7], slugs[20]])
  for (const locale of [undefined, 'en', 'fr', 'en-US', 'EN', ' en ', '!!', 'de-de', 'pt-BR', '  '])
    add('curriculumItemLocalized', true, locale === undefined ? { slug } : { slug, locale });
add('curriculumItemLocalized', true, { slug: 'no-such-slug', locale: 'en' });
for (const slug of slugs) add('curriculumStudyGuide', true, { slug });
add('curriculumStudyGuide', true, { slug: ` ${first} ` }, { slug: 'no-such-slug' });
add('curriculumStudyGuides', true, undefined, {}, { limit: 200 }, { limit: 2 });
for (const path of PATHS) add('curriculumStudyGuides', true, { path, limit: 200 });
add('curriculumDepth', true, undefined);
add('curriculumInventory', true, undefined);
add('curriculumImportStatus', true, undefined);
add('curriculumPathDeepLinks', true, undefined);
for (const path of PATHS) add('curriculumDeepLink', true, { path });
add(
  'curriculumDeepLink',
  true,
  { path: 'foundations', slug: 'foundations-risk-first' },
  { path: 'markets', slug: 'foundations-risk-first' },
  { path: 'foundations', slug: 'no-such-item' },
  { path: 'foundations', slug: '   ' },
  { path: 'foundations', slug: ' foundations-risk-first ' },
);
add('publicCurriculum', false, {}, { limit: 200 }, { limit: 2 }, { limit: 2.9 }, { limit: 0 });
for (const sort of ['recommended', 'name_asc', 'name_desc']) add('publicCurriculum', false, { sort, limit: 200 }, { sort, limit: 5 });
for (const q of ['risk', 'RISK', '', '   ', ' Book ', 'zz-no-such-phrase-zz', 'the', 'İ', 'ŞTRESS', 'paper', '—'])
  add('publicCurriculum', false, { q, limit: 200 }, { q, sort: 'name_desc', limit: 200 });
for (const path of PATHS) add('publicCurriculum', false, { path, limit: 200 }, { path, kind: 'workbook', sort: 'name_asc', limit: 200 });
for (const kind of KINDS) add('publicCurriculum', false, { kind, limit: 200 });
add('publicCurriculum', false, { q: listed[0].title, sort: 'name_asc', limit: 10 });
for (const slug of slugs) add('publicCurriculumItem', false, { slug });
add('publicCurriculumItem', false, { slug: ` ${first} ` }, { slug: 'no-such-slug' });
add(
  'publicCurriculumRelated',
  false,
  { slug: ` ${first} `, limit: 3 },
  { slug: first },
  { slug: 'no-such-slug', limit: 3 },
  { slug: slugs[24], limit: 200 },
);
add('publicHub', false, undefined);

/** The item calls asked in every scenario but the empty one, which asks every case. */
const ITEM_CASES = [
  ['curriculumItem', true, { slug: ITEM }],
  ['curriculumItemLocalized', true, { slug: ITEM, locale: 'fr' }],
  ['publicCurriculumItem', false, { slug: ITEM }],
  ['publicHub', false, undefined],
];

/**
 * An answer as the golden holds it: in full up to 2 KiB; a longer one (an item with its body) as its SHA-256, its UTF-8
 * byte count and its opening, so the file stays reviewable while equality stays exact. The full text is this script's
 * output for that case.
 */
const LONG = 2048;
const held = (answer) =>
  Buffer.byteLength(answer) <= LONG
    ? { answer }
    : {
        answerSha256: createHash('sha256').update(answer).digest('hex'),
        answerBytes: Buffer.byteLength(answer),
        answerStart: answer.slice(0, 160),
      };

const answers = [];
for (const [scenario, rows] of Object.entries(SCENARIOS)) {
  const app = await serve(rows);
  for (const [path, scoped, input] of scenario === 'empty' ? cases : ITEM_CASES) {
    answers.push({
      scenario,
      path,
      caller: scoped ? 'read' : 'anon',
      input: input === undefined ? null : JSON.stringify(input),
      ...held(await hit(app, path, input, scoped)),
    });
  }
  await app.close();
}

const internal = await (async () => {
  const INTERNAL = randomBytes(24).toString('hex');
  const app = Fastify();
  registerInternalCurriculumRoute(app, INTERNAL);
  await app.ready();
  const ok = await app.inject({
    method: 'GET',
    url: '/internal/curriculum',
    headers: serviceAuthHeadersForBody('svc-agents', INTERNAL, ''),
  });
  const refused = await app.inject({ method: 'GET', url: '/internal/curriculum' });
  await app.close();
  return { ok: `${ok.statusCode} ${ok.body}`, refused: `${refused.statusCode} ${refused.body}` };
})();

const golden = { answers, internal };

// ── Writing ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const PRETTIER = fileURLToPath(new URL('../../../node_modules/.bin/prettier', import.meta.url));
const formatted = (file, text) => execFileSync(PRETTIER, ['--stdin-filepath', file], { input: text, encoding: 'utf8', maxBuffer: 1 << 28 });
const outputs = [
  [`${CRATE}src/curriculum/spine.json`, `${JSON.stringify(spine)}\n`],
  [`${CRATE}tests/fixtures/curriculum.golden.json`, `${JSON.stringify(golden)}\n`],
];
let stale = 0;
for (const [file, raw] of outputs) {
  const text = formatted(file, raw);
  if (CHECK) {
    let was = '';
    try {
      was = readFileSync(file, 'utf8');
    } catch {}
    if (was !== text) {
      console.error(`stale: ${file.slice(ROOT.length)}`);
      stale++;
    }
  } else writeFileSync(file, text);
}
console.log(`${items.length} spine items, ${answers.length} recorded answers`);
if (stale) process.exit(1);
