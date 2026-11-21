// Records, from the TypeScript svc-academy in this checkout, what the Rust lobbies slice is held to:
//
// - `tests/fixtures/lobbies-parity.golden.json`: zod's own verdicts, through the TypeScript functions themselves, on
//   a corpus of scenes (`parseScene`, `sceneFingerprint`, `decideHostSceneWrite`) and rank-perk payloads
//   (`rankPerksSchema`).
//
// Run from the repository root, with the workspace packages built (`pnpm --filter "@intafaced/svc-academy^..." build`):
//   TZ=UTC node --import tsx crates/svc-academy/scripts/record-lobbies.mjs          writes the files
//   TZ=UTC node --import tsx crates/svc-academy/scripts/record-lobbies.mjs --check  fails when a written file is stale
//
// It stops being runnable when the TypeScript service is deleted, and from then on what it wrote is the reference.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CRATE = fileURLToPath(new URL('../', import.meta.url));
const SVC = `${ROOT}services/svc-academy/src/`;
const NAME = 'record-lobbies';
// The TypeScript service was deleted when svc-academy switched to this crate (weed project-state#3343): what this script
// wrote is now the reference, and a change to it is made in the recorded file itself. Read the TypeScript in git history.
if (!existsSync(SVC)) {
  console.error(
    `${NAME}: services/svc-academy no longer exists (the Rust crate replaced it); nothing to record from. The files it wrote are the reference now.`,
  );
  process.exit(2);
}
const CHECK = process.argv.includes('--check');

const { parseScene, emptyScene } = await import(`${SVC}spatial/scene.ts`);
const { decideHostSceneWrite, sceneFingerprint } = await import(`${SVC}spatial/edit-policy.ts`);
const { rankPerksSchema, BASE_PERKS } = await import(`${SVC}../node_modules/@intafaced/contracts/dist/index.js`);

// ── The scene corpus ───────────────────────────────────────────────────────────────────────────────────────────────

const avatar = (id, participantId, x = 1, y = 2, extra = {}) => ({ id, participantId, position: { x, y }, ...extra });
const big = { version: 1, props: [] };
for (let i = 0; Buffer.byteLength(JSON.stringify(big), 'utf8') <= 64 * 1024; i += 1) {
  big.props.push({ id: `p${i}`, kind: 'block', position: { x: i, y: i } });
}
const justUnder = { version: 1, props: big.props.slice(0, big.props.length - 1) };

const scenes = [
  null,
  {},
  [],
  'scene',
  7,
  { version: 1 },
  { version: '1' },
  { version: 2 },
  { version: 1, email: 'x@y.z' },
  { version: 1, a: 1, b: 2 },
  { stage: { width: 1, height: 1 } },
  { version: 1, stage: { width: 800, height: 600 } },
  { version: 1, stage: { width: 800, height: 600, backgroundKey: 'grid', extra: true } },
  { version: 1, stage: { width: 0, height: 600 } },
  { version: 1, stage: { width: -1, height: 10_001 } },
  { version: 1, stage: { width: 10_000, height: 0.5 } },
  { version: 1, stage: { width: '800', height: 600 } },
  { version: 1, stage: { width: 800 } },
  { version: 1, stage: null },
  { version: 1, stage: { width: 1, height: 1, backgroundKey: 'k'.repeat(121) } },
  { version: 1, avatars: [] },
  { version: 1, avatars: [avatar('a1', 'seat-9', 10, 20)] },
  { version: 1, avatars: [avatar('a1', 'seat-9', 1.5, -2.25, { facing: 0.1, labelKey: 'host', stray: 'drop me' })] },
  { version: 1, avatars: [avatar('', 'seat-9')] },
  { version: 1, avatars: [avatar('a'.repeat(65), 's')] },
  { version: 1, avatars: [{ id: 'a1', position: { x: 1, y: 1 } }] },
  { version: 1, avatars: [avatar('a1', 's', 1e21, 1e-7)] },
  { version: 1, avatars: [{ id: 'a1', participantId: 's', position: { x: 'x', y: 1 } }] },
  { version: 1, avatars: Array.from({ length: 201 }, (_, i) => avatar(`a${i}`, `s${i}`)) },
  { version: 1, avatars: [avatar('a1', 'seat-1'), avatar('a2', 'seat-1')] },
  { version: 1, avatars: [avatar('a1', 'seat-1'), avatar('a1', 'seat-2')] },
  { version: 1, props: [{ id: 'p1', kind: 'desk', position: { x: 0, y: 0 } }] },
  {
    version: 1,
    props: [
      { id: 'p1', kind: 'desk', position: { x: 0, y: 0 }, rotation: 90 },
      { id: 'p1', kind: 'chair', position: { x: 1, y: 1 } },
    ],
  },
  { version: 1, props: [{ id: 'p1', kind: '', position: { x: 0, y: 0 } }] },
  { version: 1, props: 'none' },
  { props: [], avatars: [], stage: { height: 2, width: 3 }, version: 1 },
  {
    version: 1,
    stage: { width: 3, height: 2 },
    avatars: [avatar('a1', 'p1', 1, 2)],
    props: [{ id: 'p', kind: 'k', position: { x: 0, y: 0 } }],
  },
  { version: 1, 10: 'numeric key', 2: 'another' },
  { version: 1, stage: { width: 800, height: 600 }, avatars: [avatar('é', 'ü')] },
  justUnder,
  big,
];

const parsed = scenes.map((input) => {
  const r = parseScene(input);
  return r.ok
    ? { input, ok: true, scene: r.scene, fingerprint: sceneFingerprint(r.scene) }
    : { input, ok: false, reason: r.reason, message: r.message };
});

const empty = emptyScene();
const populated = { version: 1, stage: { width: 100, height: 100 }, avatars: [avatar('a1', 'seat-1', 1, 1)] };
const writes = [];
for (const current of [empty, populated, { version: 1, props: [{ id: 'p1', kind: 'desk', position: { x: 0, y: 0 } }] }]) {
  for (const next of [{ version: 1 }, { version: 99 }, { version: 1, stage: { width: 200, height: 200 } }, scenes[29], scenes[30], big]) {
    for (const expectedFingerprint of [
      undefined,
      '',
      '   ',
      'deadbeef',
      sceneFingerprint(current),
      `  ${sceneFingerprint(current)}  `,
      sceneFingerprint(empty),
    ]) {
      const r = decideHostSceneWrite({ current, next, ...(expectedFingerprint !== undefined ? { expectedFingerprint } : {}) });
      writes.push({ current, next: next === big ? 'BIG' : next, expectedFingerprint: expectedFingerprint ?? null, result: r });
    }
  }
}

// ── The rank-perk corpus ───────────────────────────────────────────────────────────────────────────────────────────

const perks = [
  BASE_PERKS,
  { ...BASE_PERKS, lobbyHostRights: true },
  { ...BASE_PERKS, lobbyHostRights: 'yes' },
  { lobbyHostRights: true },
  { ...BASE_PERKS, feeDiscountBps: 10_000, extra: 1 },
  { ...BASE_PERKS, feeDiscountBps: 10_001 },
  { ...BASE_PERKS, feeDiscountBps: 1.5 },
  { ...BASE_PERKS, p2pLimitMultiplier: 0.5 },
  { ...BASE_PERKS, p2pLimitMultiplier: 1.5 },
  { ...BASE_PERKS, copyFollowerCap: -1 },
  { ...BASE_PERKS, cardTier: 'gold' },
  { ...BASE_PERKS, launchpadTier: 2 ** 53 },
  null,
  [],
  'perks',
].map((input) => {
  const r = rankPerksSchema.safeParse(input);
  return { input, ok: r.success, ...(r.success ? { output: r.data } : {}) };
});

// ── Write or check ──────────────────────────────────────────────────────────────────────────────────────────────────

const files = [
  [
    `${CRATE}tests/fixtures/lobbies-parity.golden.json`,
    `${JSON.stringify({ big, parsed: parsed.map((p) => (p.input === big ? { ...p, input: 'BIG' } : p)), writes, perks })}\n`,
  ],
];
/** Each file leaves in the shape `format:check` holds it to, as `record-door.mjs` writes its own. */
const PRETTIER = fileURLToPath(new URL('../../../node_modules/.bin/prettier', import.meta.url));
const formatted = (path, text) => execFileSync(PRETTIER, ['--stdin-filepath', path], { input: text, encoding: 'utf8', maxBuffer: 1 << 28 });

let stale = false;
for (const [path, raw] of files) {
  const text = formatted(path, raw);
  if (CHECK) {
    let old = '';
    try {
      old = readFileSync(path, 'utf8');
    } catch {}
    if (old !== text) {
      console.error(`record-lobbies: ${path} is stale`);
      stale = true;
    }
  } else {
    writeFileSync(path, text);
  }
}
if (stale) process.exit(1);
console.log(CHECK ? 'record-lobbies: up to date' : 'record-lobbies: written');
