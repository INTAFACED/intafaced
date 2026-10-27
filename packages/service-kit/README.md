# @intafaced/service-kit

What a new backend slice would otherwise write by hand, written once: typed refusals, owner values, the owner check, and
the test set-up. It also has a scaffold that writes a slice's first files already using the kit. It never posts to the
ledger and never imports `@intafaced/ledger-client`: money still moves only through its recipes.

## Why these four

New service code merged between 19 and 27 Oct 2026 (1,585 new files under `services/*/src`), checked with a clone
detector (jscpd, 30 tokens or more):

- **Tests repeat, source mostly doesn't.** 20% of new test lines are copies, against 4% of new source lines.
- **The biggest copies are set-up.** 321 new test files read their own migrations with the same eight lines and build a
  test database the same way, about 15 lines a file. Mounted router tests copy the edge-signed caller (secret,
  principal, signed headers): the same block appears in at least 18 new test files.
- **Refusals are written four times.** Each area writes a code union, a status map, an error class and a mapper (106 new
  error classes, 24 new status maps). Service source has 187 copies of `try { … } catch (err) { throw map(err) }`.
- **Blank owner values** are read as `z.preprocess((v) => (v === '' ? undefined : v), …)` and refused by hand.

Step-up is left out on purpose. Each money door binds its own fields and consumes svc-identity's approval through its
own store (for example `svc-bank/src/step-up/step-up-gate.ts`). A shared wrapper would be a second way to do the same
thing, not less code.

## Use

```ts
import { blankAsUnset, defineRefusals, requireOwned, requireSetting } from '@intafaced/service-kit';

export const reports = defineRefusals('GradeReportError', {
  'academy.course_not_found': 'NOT_FOUND',
  'academy.grade_report_cap_unset': 'PRECONDITION_FAILED',
});

// env.ts: blank stays unset, never zero
ACADEMY_GRADE_REPORT_CAP: blankAsUnset(z.coerce.number().int().min(0)),

// service: a blank owner value refuses before anything is written; someone else's row reads as missing
const cap = requireSetting(env.ACADEMY_GRADE_REPORT_CAP, reports, 'academy.grade_report_cap_unset');
const row = requireOwned(found, (r) => r.owner_id, caller, reports, 'academy.course_not_found');

// router: the refusal keeps its code on the wire (error.data.cause.code)
.mutation(({ ctx, input }) => reports.guard(() => service.save(input, ctx.principal!)))
```

Tests:

```ts
import { edgeCallers, expectRefusal, useServiceDb } from '@intafaced/service-kit/testing';

const db = useServiceDb({ service: 'academy', from: import.meta.url }); // migrations, truncate, drop
const callers = edgeCallers({ serviceName: 'svc-academy', scopes: ['academy:read'] });
router.createCaller(callers.signed()); // or callers.anonymous(), callers.forged()
await expectRefusal(call, 'academy.grade_report_cap_unset', 'PRECONDITION_FAILED');
```

## The scaffold

```
pnpm --filter @intafaced/service-kit slice:new -- --service svc-academy --name grade-reports \
  --dir curriculum --slice AC-assignments-04 [--area academy] [--scope academy] [--dry-run]
```

It writes a migration pair named for the UTC second (`tooling/ci/migration-check.mjs`), the store with its refusals and
an owner-value cap, the procedures with the scope and the owner check, and a database test covering the happy path,
every refusal, a refusal that writes nothing, and a race on the cap. The files pass as written. It then prints what to
add by hand in the shared files: the service's dependency on this package, the env line, the router mount, and the
TEST owner value. It refuses to overwrite an existing file.
