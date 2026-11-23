#!/usr/bin/env node
// Customer rooms in Volt, n of N: prints the count as JSON. The rule and the room list are in
// apps/customer/src/app/volt-count.ts; the ratchet that keeps n from falling is apps/customer/src/app/volt-count.test.ts,
// against the rooms still allowed off the kit in apps/customer/src/app/volt-off-kit.json. A room is recorded as moved by the
// `// volt-room: <route>` line in its own screen file, so no batch edits a shared file; a batch leaves the list stale,
// which passes, and `node tooling/design/prune-lists.mjs`, in its own PR, drops the stale entries.
// Needs the workspace packages built (`pnpm turbo run build --filter=@intafaced/customer^...`), as the customer tests do.
//   node tooling/design/volt-count.mjs            the whole count: n, N, the rule, every room with its state and reason, the batches
//   node tooling/design/volt-count.mjs --summary  n of N and the batches with their sizes
import { tsImport } from 'tsx/esm/api';

const { voltCount } = await tsImport('../../apps/customer/src/app/volt-count.ts', import.meta.url);
const count = voltCount();
const out = process.argv.includes('--summary')
  ? { n: count.n, N: count.N, batches: count.batches.map(({ batch, size }) => ({ batch, size })) }
  : count;
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
