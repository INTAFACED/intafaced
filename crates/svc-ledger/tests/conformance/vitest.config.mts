// The posting slice's TypeScript proofs against the Rust binary (`run.mjs` runs them and holds them to one result):
// - `conformance` (`posting.conformance.ts`): the TypeScript ledger's own suite, through the TS `post` door and the
//   Rust binary's;
// - `binding-pg`: the slice's own Postgres tests (`services/svc-ledger/src/*-binding.pg.test.ts`), unmodified, with
//   `createTestDb` handing them the Rust binary's book (`rust-db.ts`) and `handleS2sPost` posting to its door
//   (`rust-s2s-http.ts`). Their setup posts go through the TypeScript engine, on the same book;
// - `engine-ts-door` and `engine-rust-door`: the engine's Postgres tests (`services/svc-ledger/src/ledger/`), unmodified,
//   with every `post` sent through the TypeScript door (`ts-postgres-ledger.ts`) and then the Rust one
//   (`rust-postgres-ledger.ts`, on the Rust binary's book). The reads stay the TypeScript's.
// The crate has no node_modules of its own, so `postgres` is the one svc-ledger uses.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const postgres = { find: 'postgres', replacement: here('../../../../services/svc-ledger/node_modules/postgres/src/index.js') };
const rustDb = { find: /^@intafaced\/db(\/testing)?$/, replacement: here('./rust-db.ts') };
const engine = (file: string) => ({ find: /^\.\/postgres-ledger\.js$/, replacement: here(file) });
const shared = { fileParallelism: false, testTimeout: 60_000, hookTimeout: 180_000 };
const ENGINE_TESTS = [
  'services/svc-ledger/src/ledger/postgres-ledger.test.ts',
  'services/svc-ledger/src/ledger/*.pg.test.ts',
  'services/svc-ledger/src/ledger/*-postgres.test.ts',
];

export default defineConfig({
  test: {
    root: here('../../../../'),
    projects: [
      {
        resolve: { alias: [postgres] },
        test: { ...shared, name: 'conformance', include: ['crates/svc-ledger/tests/conformance/*.conformance.ts'] },
      },
      {
        resolve: { alias: [postgres, rustDb, { find: /^\.\/s2s-http\.js$/, replacement: here('./rust-s2s-http.ts') }] },
        test: { ...shared, name: 'binding-pg', include: ['services/svc-ledger/src/*-binding.pg.test.ts'] },
      },
      {
        resolve: { alias: [postgres, engine('./ts-postgres-ledger.ts')] },
        test: { ...shared, name: 'engine-ts-door', include: ENGINE_TESTS },
      },
      {
        resolve: { alias: [postgres, rustDb, engine('./rust-postgres-ledger.ts')] },
        test: { ...shared, name: 'engine-rust-door', include: ENGINE_TESTS },
      },
    ],
  },
});
