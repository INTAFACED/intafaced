# SERVICE TEMPLATE

Copy this shape for every `services/svc-*`. Uniformity is the point: an agent that has worked in one service can work in any of them.

---

## `package.json`

```json
{
  "name": "@intafaced/svc-<name>",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "node ../../tooling/scripts/tsc.mjs -p tsconfig.json --noEmit && node ../../tooling/ci/test-typecheck.mjs",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "clean": "rimraf dist .turbo"
  },
  "dependencies": {
    "@intafaced/config": "workspace:*",
    "@intafaced/contracts": "workspace:*",
    "@intafaced/db": "workspace:*",
    "@intafaced/events": "workspace:*",
    "@intafaced/auth": "workspace:*",
    "fastify": "^5.2.0"
  }
}
```

Add `@intafaced/ledger-client` **only** if the service moves value — and never to a Protocol Plane service (`custody-scan` will reject it).

---

## `src/env.ts`

```ts
import { z } from 'zod';
import { loadEnv, serviceEnvSchema } from '@intafaced/config';

const schema = serviceEnvSchema.merge(
  z.object({
    // this service's own variables, and only its own
    SOMETHING_SPECIFIC: z.string().min(1),
  }),
);

export const env = loadEnv(schema);
export type Env = typeof env;
```

---

## `src/db/schema.ts`

```ts
import { pgSchema, text, integer } from 'drizzle-orm/pg-core';
import { pk, createdAt, amount, citext } from '@intafaced/db';

/** THIS SERVICE'S SCHEMA ONLY. Never reference another service's tables. */
export const schema = pgSchema('<name>');

export const things = schema.table('things', {
  id: pk(),
  handle: citext('handle').notNull().unique(),
  balanceRef: text('balance_ref'), // a ledger ACCOUNT ID — never a balance
  createdAt: createdAt(),
});
```

> A column named `balance`, `amount_held`, or anything that looks like a running total is a doctrine violation unless it is a denormalised cache with a documented reconciliation job. The truth lives in the ledger.

---

## `src/index.ts`

```ts
import Fastify from 'fastify';
import { createDb } from '@intafaced/db';
import { JetStreamEventBus } from '@intafaced/events';
import { env } from './env.js';
import * as schema from './db/schema.js';
import { appRouter } from './router.js';

const db = createDb(
  { url: env.DATABASE_URL, schema: '<name>', max: env.DATABASE_POOL_MAX },
  schema,
);
const bus = await JetStreamEventBus.connect({
  servers: env.NATS_URL,
  producer: env.SERVICE_NAME,
  ownedStreams: ['<name>'],
});

const app = Fastify({ logger: { level: env.LOG_LEVEL } });

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });

// Draining, not dropping: in-flight money paths finish before the process exits.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    await app.close();
    await bus.close();
    await db.close();
    process.exit(0);
  });
}
```

---

## `README.md` — required sections (§14 checks for these)

```markdown
# svc-<name>

One line: what this service is responsible for, and what it is NOT.

## API

| Procedure   | Scope         | Input    | Output  |
| ----------- | ------------- | -------- | ------- |
| `thing.get` | `<name>:read` | `{ id }` | `Thing` |

## Events

**Publishes**

| Subject                          | When | Payload        |
| -------------------------------- | ---- | -------------- |
| `intafaced.<name>.thing.created` | …    | `ThingCreated` |

**Consumes**

| Subject                        | Consumer (durable) | Effect |
| ------------------------------ | ------------------ | ------ |
| `intafaced.identity.xp.earned` | `<name>-xp`        | …      |

## Ledger

Recipes this service invokes, and the accounts they touch.

| Recipe      | Reason code  | Accounts                   |
| ----------- | ------------ | -------------------------- |
| `orderHold` | `order.hold` | user available → user hold |

_If this service moves no value: "This service holds no balances and posts no ledger transactions."_

## Kill-switch

`module.<name>` in the admin console. Effect when off: …
```

---

## Checklist before opening the PR

- [ ] `pnpm gate svc-<name>` green
- [ ] Migrations have `.down.sql` reversals
- [ ] Every money path has an invariant test
- [ ] Every user-facing string is i18n-keyed
- [ ] README's three required sections are filled in, not stubbed
- [ ] No TODO says "later" without a §13 socket reference
