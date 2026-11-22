#!/usr/bin/env node
// Customer rooms in Volt, n of N: prints the count as JSON. The rule and the room list are in
// apps/customer/src/app/volt-count.ts; the ratchet that keeps n from falling is apps/customer/src/app/volt-count.test.ts,
// against the rooms still allowed off the kit in apps/customer/src/app/volt-off-kit.json. A room is recorded as moved by the
// `// volt-room: <route>` line in its own screen file, so no batch edits a shared file; a batch into a Volt
// layer leaves the list stale, and one `--write` on the layer before its PR into main tightens it.
// Needs the workspace packages built (`pnpm turbo run build --filter=@intafaced/customer^...`), as the customer tests do.
//   node tooling/design/volt-count.mjs            the whole count: n, N, the rule, every room with its state and reason, the batches
//   node tooling/design/volt-count.mjs --summary  n of N and the batches with their sizes
//   node tooling/design/volt-count.mjs --write    drops from volt-off-kit.json each room now in Volt or gone; it never adds one
import { readFileSync, writeFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';

const { voltCount } = await tsImport('../../apps/customer/src/app/volt-count.ts', import.meta.url);
const count = voltCount();
if (process.argv.includes('--write')) {
  const file = new URL('../../apps/customer/src/app/volt-off-kit.json', import.meta.url);
  const off = new Set(count.rooms.filter((r) => r.state !== 'volt').map((r) => r.key));
  const before = JSON.parse(readFileSync(file, 'utf8'));
  const after = before.filter((key) => off.has(key));
  writeFileSync(file, `${JSON.stringify(after, null, 2)}\n`);
  process.stdout.write(`volt-off-kit.json: ${before.length} -> ${after.length} (dropped ${before.length - after.length})\n`);
  process.exit(0);
}
const out = process.argv.includes('--summary')
  ? { n: count.n, N: count.N, batches: count.batches.map(({ batch, size }) => ({ batch, size })) }
  : count;
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
