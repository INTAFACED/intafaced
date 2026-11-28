# Tests that read source text: the recipe

Every finding of `garden/no-source-text-test` goes, one site at a time, by this page. Read it whole
before you touch a file. You do not edit this page, the classifier, or the rule; a case they get wrong goes back to
whoever gave you the files, with the site and why.

## 1. Sort the site

Run `node tooling/lint/source-text/classify.mjs <your files>`. For each site it prints the path read, the test block(s)
the read sits in or feeds, what those blocks assert, and whether the test is **protected** (money, custody, sign-in,
permissions, a journey). Then read the test yourself and write down, in one sentence, **the property** it means to hold:
not "the file contains X", but what would break for a user, an operator or another service if X went.

Then find what else holds that property today, in this order:

1. **Another test** that calls the code and asserts the same thing (often in the same file, right below). Search the
   package and the code the text came from: `rg -n '<the function, error code or constant>' <package> services/<svc>`.
2. **A type** that makes the bad state unwritable (a union, a branded type, a required field).
3. **A lint rule** (`.oxlintrc.json`, `tooling/lint/oxlint-plugin-garden/`) or **a boundary check**
   (`tooling/ci/boundary-scan.mjs`, `pnpm scan:custody`, `pnpm scan:brand`).

## 2. Its verdict

Record it in `tooling/lint/source-text/verdicts/<part>.json`, one entry per site, then act on it:

```json
{
  "file": "<test file>",
  "target": "<the path the finding names>",
  "verdict": "delete|rewrite|rule",
  "asserts": "<the property, one sentence>",
  "guard": { "kind": "test|type|lint|boundary", "ref": "<see below>" },
  "why": "<one sentence: why that guard holds the same property, or what the rewrite now checks>"
}
```

`ref`: a test as `<path>#<words of its title>`; a type as `<path>#<name>`; a lint as its rule name; a boundary check
as a name `tooling/ci/boundary-scan.mjs` contains.

- **delete**: the property is already held by the guard you name, as strongly (a behaviour test, not another text read).
  Run `node tooling/lint/source-text/classify.mjs <files> --check`, then `--apply`: it deletes the block and the read,
  and the imports nothing uses any more. Never for a protected test.
- **rewrite**: nothing holds it, or the test is protected. Rewrite it against behaviour (section 3). `guard` names the
  rewritten test.
- **rule**: the read is not source text at all (data, a fixture, a generated file the test compares to its generator).
  Do not change the test; report it back with why. The rule is changed by one hand only.

## 3. How to rewrite

The test must call the code and assert on its answer, the records it writes, or the events it emits:

- "the router refuses X with code C" → call the router (or the procedure, the handler, `createCaller`) and assert the
  refusal and its code.
- "the module exports X / the entry mounts Y" → import the entry and assert X is the function or value it must be,
  and call it once.
- "the file sets a default / refuses a blank owner value" → call the loader with the value missing and assert the
  typed refusal; with a value, assert it is used.
- "no copy of a list drifts from the source" → import both lists and compare them.
- "a component renders the notice" → render it and assert what the user sees.
- "two services agree on a hash, a key or a shape" → import both functions or the shared contract and compare their
  outputs on the same input. A test in another package than the service whose code it read asserts through the
  service's public record or contract (`@intafaced/contracts`), or moves beside the service as a test of it.

## 4. The verification contract

For each part, in the PR:

1. `node tooling/lint/count-rule.mjs garden/no-source-text-test <your files>` prints `0`.
2. Each touched package's unit tests pass (`pnpm --filter <package> test`, or `node --test <file>` for tooling), and its
   types (`pnpm --filter <package> typecheck`) and lint (`pnpm lint <files>`) pass.
3. **One planted break per part**: for one rewritten test, break the behaviour it now checks in the code under test
   (not the test), run it, and show it fails; restore. Paste the command and the failing line in the PR.
4. Every deleted site names its guard, and that guard's test passes. A part that removes assertions carries a
   `Test-change:` line in its PR body naming each one's guard (`tooling/ci/test-diff-guard.mjs` reads it at push).

## 5. The fences

- Never edit a journey test (`apps/customer/tests/real-app/`) unless the part says so.
- **Never delete** a test of money, custody, sign-in, permissions or a journey: rewrite it so it keeps every
  protection it has today. Never weaken an assertion to get green, and never skip a test.
- **No evasion.** Reading the source by another route (an alias of `readFileSync`, `fs.promises`, `?raw` imports,
  `child_process`, `import.meta.glob` of source, a path built so the rule cannot see it) is the same finding hidden,
  and fails the part.
- Change no production code to make a test easier, except to export a function or constant that already exists, and
  then name it in the PR.
- Edit only the files given to you, plus the verdict file of your part.
