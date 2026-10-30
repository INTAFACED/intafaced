#!/usr/bin/env node
/**
 * WORKSPACE SYNC — every workspace package reaches the image and the fleet.
 *
 * Three times in one day a service was added and a deployment file was not:
 *
 *   1. five mounted services never received EDGE_PRINCIPAL_SECRET in compose,
 *      so each would crash-loop on a boot secret that has no default;
 *   2. svc-edge — the front door — had no compose block at all, so the fleet
 *      came up behind a door that was never opened;
 *   3. four services were missing from the Dockerfile's manifest list.
 *
 * None of those failed loudly at the point of the mistake. The Dockerfile one
 * is the nastiest: pnpm installs a workspace whose manifest it cannot see as
 * though it had no dependencies, so the error arrives much later as
 * "Cannot find module '@intafaced/contracts'" during a build — which reads like
 * a broken import, not a missing COPY.
 *
 * This makes all three loud, at the commit that causes them.
 *
 * ── The shape every rule here shares ────────────────────────────────────────
 *
 * Each check exists because something came up GREEN while being wrong. That is
 * the only class this file is for. A container that crashes is already loud; a
 * container that is healthy, passes its health check, and answers 404 or
 * ECONNREFUSED on everything else is not, and it has cost this repo several
 * sessions each time. Checks 5 and 6 came from exactly that, and 7–10 below
 * cover the variants they still let through — a database role that was never
 * created, a schema no runner migrates, a hostname that does not resolve, and a
 * dev fallback pointing at a live service that answers a different API.
 *
 * If you add a rule, say WHY in the code. A gate whose reasoning is elsewhere
 * gets deleted by the next person who hits it at an inconvenient moment.
 *
 * Exit 0 = the workspace, the image and the fleet agree.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';

const ROOT = process.cwd();

/** Every workspace package that produces a deployable service. */
function servicesInRepo() {
  const dir = join(ROOT, 'services');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'package.json')))
    .map((d) => d.name)
    .sort();
}

/** Every workspace directory under `dir` that carries a package.json. */
function workspacesUnder(dir) {
  const root = join(ROOT, dir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'package.json')))
    .map((d) => d.name)
    .sort();
}

/**
 * The folders pnpm-workspace.yaml takes every workspace from (`- 'tooling/*'` gives `tooling`). A pattern of any other
 * shape is a failure here, so a new kind of entry is read on purpose rather than skipped.
 */
function workspaceGlobDirs() {
  const yaml = read('pnpm-workspace.yaml') ?? '';
  const dirs = [];
  let inPackages = false;
  for (const line of yaml.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    const m = inPackages && /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line);
    if (!m) continue;
    const glob = /^([a-z][a-z0-9_-]*)\/\*$/.exec(m[1]);
    if (glob) dirs.push(glob[1]);
    else
      failures.push({
        file: 'pnpm-workspace.yaml',
        reason: `workspace pattern "${m[1]}" is not "<folder>/*", which this check reads; teach it the new shape`,
      });
  }
  if (!dirs.length) failures.push({ file: 'pnpm-workspace.yaml', reason: 'no "<folder>/*" workspace patterns found under packages:' });
  return dirs;
}

const packagesInRepo = () => workspacesUnder('packages');
const appsInRepo = () => workspacesUnder('apps');

/**
 * Every package under `vendor/`, at ANY depth. Used by check 7 below.
 *
 * `workspacesUnder` cannot do this job and check 7 used to ask it to — twice,
 * nested — which is why check 7 discovered NOTHING under `vendor/` for the two
 * days it existed. `workspacesUnder('vendor')` only returns directories that
 * THEMSELVES carry a package.json, and the vendored tree's top level is a plain
 * directory: the manifests sit one level below it. So the outer call returned
 * `[]`, the inner call never ran, and the front-end this check was written for
 * — 92 Vue files — was invisible to it. The gate reported clean while looking
 * at nothing.
 *
 * `apps/` and `packages/` are OUR layout and are exactly one level deep, so
 * `workspacesUnder` remains right for them. A vendored tree has whatever layout
 * upstream chose, and pinning a depth is how the next one escapes. So this
 * walks until it finds manifests rather than assuming where they are.
 *
 * Directories are NOT named here — discovered. Spelling the vendored path in
 * this file would put the upstream vendor's identity in our own source and trip
 * `brand-scan` (§0.7, and `tooling/ci/` is not allowlisted there). Discovery is
 * also the better rule regardless: a second vendored tree is covered the moment
 * it lands, with no edit here.
 *
 * The walk stops at a package boundary. A package's own internals (its build
 * directory, its bundled tooling) are not separately deployable things, and
 * descending into them is how a gate starts reporting on a webpack config.
 */
function vendoredPackages() {
  // Build output and dependency trees: full of manifests, none of them ours.
  const SKIP = new Set(['node_modules', '.git', 'target', 'dist', '.next', '.turbo', 'coverage']);
  const found = [];

  const visit = (rel) => {
    if (!existsSync(join(ROOT, rel))) return;
    for (const d of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      if (!d.isDirectory() || SKIP.has(d.name)) continue;
      const child = join(rel, d.name);
      if (existsSync(join(ROOT, child, 'package.json'))) found.push({ name: d.name, dir: child });
      else visit(child);
    }
  };

  visit('vendor');
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** A discovered directory name goes into a RegExp; discovered names are not ours to trust. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function read(file) {
  const path = join(ROOT, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** How many `.sql` migration files a service ships, or 0 if it has no migration directory. */
function migrationCount(svc) {
  const dir = join(ROOT, 'services', svc, 'drizzle');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).length;
}

const services = servicesInRepo();
const failures = [];

// What this run actually OPENED. Printed on the summary line, because the whole
// class of bug this file is for has a second half nothing here covered: a check
// that runs, finds nothing to look at, and reports clean. `0 service(s) reach
// both the image and the fleet` was a passing line. It should never have been.
let copyPathsChecked = 0;
let frontendsInspected = 0;
let vendoredInspected = 0;

// ── 0 · this gate looked at something ───────────────────────────────────────
//
// Checks 1–10 are all `for (const svc of services)`. An empty `services` makes
// every one of them a no-op and the run exits 0 — and it does not take a deleted
// directory to get there. `servicesInRepo` reads `services/` from `process.cwd()`,
// so ANY caller that runs this from the wrong directory gets a green tick for a
// tree it never opened. That is not hypothetical: `pnpm verify` and CI invoke
// gates from the repo root today, and nothing enforces it.
//
// This is the house rule from `tooling/ci/fabricated-money-scan.mjs` (deleted 2026-10-13): discovery
// finding nothing is a REPORT, never a silent pass. There it is a loud exit 0
// because the shell may legitimately be gone. Here it is a failure, because a
// monorepo with no services is not a state this repo can be in — it is a broken
// invocation, and passing it would clear the gate for every other check too.
if (services.length === 0) {
  failures.push({
    file: 'services/',
    reason:
      'no service packages found, so checks 1-10 below each iterated an empty list and had nothing to say. This gate cannot pass on a tree it did not open — either the directory is gone, or this ran from somewhere that is not the repo root',
  });
}

// ── 1 · the image can install every workspace ───────────────────────────────
//
// This checked `services/` only, and on 2026-08-02 that gap broke the image
// build on `main`: `packages/venue-contracts` was added without its COPY line,
// so pnpm installed it as a workspace with no dependencies, `ledger-client`
// never linked, and the build died with
//
//   Cannot find module '@intafaced/ledger-client/money'
//
// plus a nonsense `number`/`bigint` comparison error downstream, because the
// missing module made `Amount` resolve to something else. Neither error names
// the Dockerfile. The gate that exists to catch exactly this was looking at the
// wrong half of the workspace.
//
// A package is no less required than a service — arguably more, since every
// service imports several. So both are checked.
const dockerfile = read('Dockerfile');
if (dockerfile === null) {
  failures.push({ file: 'Dockerfile', reason: 'missing entirely' });
} else {
  // Every folder pnpm-workspace.yaml names, not a list kept here: on 2026-10-30 `tooling/pay-sim` (#6781) joined the
  // workspace through `tooling/*` with no COPY line, this check looked only at services, packages and apps, and the
  // image build failed with "Cannot find module 'postgres'" in pay-sim.
  const workspaces = [
    ...services.map((name) => `services/${name}`),
    ...workspaceGlobDirs()
      .filter((dir) => dir !== 'services')
      .flatMap((dir) => workspacesUnder(dir).map((name) => `${dir}/${name}`)),
  ];

  for (const ws of workspaces) {
    if (!dockerfile.includes(`${ws}/package.json`)) {
      failures.push({
        file: 'Dockerfile',
        reason: `no COPY for ${ws}/package.json — pnpm will install it as if it had no dependencies, and the build fails later with a misleading "cannot find module" that never names this file`,
      });
    }
  }

  // ── 1b · and no COPY names a path that is no longer there ─────────────────
  //
  // The check above is one-directional: it asks whether every workspace HAS a
  // COPY. It never asks whether every COPY still has a workspace. So the list
  // above catches an addition and is completely blind to a REMOVAL, which is
  // the half that is about to matter — `apps/web` is being retired, and its
  // COPY line will outlive it unless something says so.
  //
  // What that costs, precisely, is why this is worth the lines. `pnpm verify`
  // does not build images. Nothing in the gate set does. So a stale COPY is
  // clean through every check we own and fails in CI at
  //
  //   COPY failed: file not found in build context ... apps/web/package.json
  //
  // which names the Dockerfile and not the deletion three commits back that
  // caused it — and it fails at image build, after the whole test suite has
  // gone green, which is the most expensive place in the pipeline to find it.
  // Deleting a directory is the moment this is obvious; CI is the moment it is
  // not. This check moves it to the first one.
  //
  // Sources are resolved against the BUILD CONTEXT, which is the repo root
  // (see `docker-compose.apps.yml` build.context), so `existsSync` from ROOT is
  // the same question Docker will ask.
  //
  // Not covered, deliberately: a path that exists here but is excluded by
  // `.dockerignore` fails identically at build time and is invisible to this.
  // Every source in this file today is a `package.json`, and `.dockerignore`
  // excludes no manifests, so the gap is currently empty — but it is a gap, and
  // the fix is to read `.dockerignore` here the day a COPY source needs it.
  //
  // A line continuation makes one COPY out of several lines; join them before
  // splitting, or the tail of a wrapped COPY parses as a command of its own.
  for (const line of dockerfile.replace(/\\\r?\n/g, ' ').split('\n')) {
    const match = /^\s*COPY\s+(.+)$/i.exec(line);
    if (!match) continue;
    const tokens = match[1].trim().split(/\s+/);

    // `--from=<stage>` copies out of an earlier BUILD STAGE, not out of the
    // context. Those paths are produced by the build and are not on this disk;
    // testing them here would fail on `/app` every single run.
    if (tokens.some((t) => t.startsWith('--from='))) continue;

    // Last token is the destination — inside the image, nothing to check here.
    for (const src of tokens.filter((t) => !t.startsWith('--') && !t.startsWith('<')).slice(0, -1)) {
      // `.` is the whole context. A wildcard may legitimately match nothing at
      // build time and is not resolvable with `existsSync`; both are skipped
      // rather than guessed at, and neither appears in this file today.
      if (src === '.' || src === './' || /[*?[\]]/.test(src)) continue;
      copyPathsChecked++;
      if (!existsSync(join(ROOT, src))) {
        failures.push({
          file: 'Dockerfile',
          reason: `COPY names "${src}", which does not exist in the build context — nothing in "pnpm verify" builds an image, so this is clean through every gate we own and then fails CI with "COPY failed: file not found", naming this file rather than the deletion that caused it`,
        });
      }
    }
  }
}

// ── 2 · the fleet actually runs every service ───────────────────────────────
const compose = read('docker-compose.apps.yml');
if (compose === null) {
  failures.push({ file: 'docker-compose.apps.yml', reason: 'missing entirely' });
} else {
  for (const svc of services) {
    // A service may legitimately be absent if it is not deployable, but that
    // must be a decision someone wrote down rather than an oversight.
    if (!new RegExp(`^\\s{2}${svc}:`, 'm').test(compose) && !compose.includes(`# no-deploy: ${svc}`)) {
      failures.push({
        file: 'docker-compose.apps.yml',
        reason: `no service block for ${svc} — it will never start. If that is deliberate, add a "# no-deploy: ${svc}" comment saying why`,
      });
    }
  }
}

// ── 3 · a service that mounts /trpc gets the secret it cannot boot without ──
// `edgeEnvSchema` has NO default, by design: a service that cannot authenticate
// the edge must refuse to start rather than serve every caller as anonymous.
// So a missing secret is a crash loop, not a warning.
if (compose !== null) {
  for (const svc of services) {
    const env = read(`services/${svc}/src/env.ts`);
    if (!env?.includes('edgeEnvSchema')) continue;

    const block = new RegExp(`^  ${svc}:([\\s\\S]*?)(?=^  \\S|\\Z)`, 'm').exec(compose);
    if (block && !block[1].includes('edge-secret')) {
      failures.push({
        file: 'docker-compose.apps.yml',
        reason: `${svc} merges edgeEnvSchema but its compose block does not receive *edge-secret — it will crash-loop on EDGE_PRINCIPAL_SECRET`,
      });
    }
  }
}

// ── 3b · same rule, second secret: authEnvSchema needs JWT_ACCESS_SECRET ────
//
// Check 3 caught `edgeEnvSchema` and stopped there, so the identical mistake
// with a different secret went straight through it. On 2026-08-03 svc-ledger —
// THE LEDGER — crash-looped on `JWT_ACCESS_SECRET: Required`. It merges
// `authEnvSchema` for its operator surface, three other blocks are handed the
// variable, and its own block never was.
//
// It stayed hidden because the failure needs a container RECREATE to surface:
// a long-running container keeps the environment it started with, so the fleet
// looked healthy for as long as nobody restarted it. It took an unrelated
// `--force-recreate` of another service to expose it.
//
// A gate that names one secret is a gate for one secret. Both are checked.
if (compose !== null) {
  for (const svc of services) {
    const env = read(`services/${svc}/src/env.ts`);
    if (!env?.includes('authEnvSchema')) continue;

    // `\\s` — inside a template literal a single backslash is dropped, so `\s`
    // becomes the letter s and the block never matches. The first draft of this
    // check reported clean against a service that was crash-looping in front of
    // me. Same trap as check 7's first draft.
    const block = new RegExp(`^  ${svc}:([\\s\\S]*?)(?=^  \\S|\\Z)`, 'm').exec(compose);
    if (block && !block[1].includes('JWT_ACCESS_SECRET')) {
      failures.push({
        file: 'docker-compose.apps.yml',
        reason: `${svc} merges authEnvSchema but its compose block does not set JWT_ACCESS_SECRET — it will crash-loop the moment the container is recreated, and look fine until then`,
      });
    }
  }
}

// ── 4 · no two services claim the same host port ────────────────────────────
// Docker does not detect this until the second container tries to bind, so the
// fleet comes up MOSTLY working and one service is missing — which reads like
// that service crashed rather than like a config clash. svc-dex and svc-indexer
// both claimed 4013 and only the second one to start failed.
if (compose !== null) {
  const claimed = new Map();
  const re = /^  ([a-z0-9-]+):([\s\S]*?)(?=^  \S|\Z)/gm;
  for (const [, name, body] of compose.matchAll(re)) {
    for (const [, host] of body.matchAll(/ports: \['(\d+):/g)) {
      if (claimed.has(host)) {
        failures.push({
          file: 'docker-compose.apps.yml',
          reason: `port ${host} is claimed by both ${claimed.get(host)} and ${name} — whichever starts second fails to bind, and it looks like a crash rather than a clash`,
        });
      } else {
        claimed.set(host, name);
      }
    }
  }
}

// ── 5 · EVERY service calls each other on the port it actually listens on ───
// Nothing catches this until a request fails at runtime with ECONNREFUSED, and
// the fleet looks entirely healthy meanwhile: every container is up, every
// health check passes, and only the proxied call fails. Five of ten upstream
// URLs were wrong at once because the route table was written from memory
// rather than read from the compose.
//
// This originally inspected only svc-edge's own environment block, on the
// assumption that the edge is where cross-service URLs live. It is not:
// svc-dex called svc-indexer on 4012 when it listens on 4013, that URL sat in
// svc-dex's block, and the gate stayed green through the whole thing. Any
// service may name any other, so every block is checked.
if (compose !== null) {
  const listens = new Map();
  for (const [, name, body] of compose.matchAll(/^  (svc-[a-z0-9-]+):([\s\S]*?)(?=^  \S|\Z)/gm)) {
    const port = /HTTP_PORT: '(\d+)'/.exec(body);
    if (port) listens.set(name, port[1]);
  }

  for (const [, caller, body] of compose.matchAll(/^  ([a-z0-9-]+):([\s\S]*?)(?=^  \S|\Z)/gm)) {
    for (const [, varName, svc, port] of body.matchAll(/(\w+_URL): http:\/\/(svc-[a-z0-9-]+):(\d+)/g)) {
      const real = listens.get(svc);
      if (real && real !== port) {
        failures.push({
          file: 'docker-compose.apps.yml',
          reason: `${caller} calls ${svc} on ${port} via ${varName}, but ${svc} listens on ${real} — every request through that route fails while both containers report healthy`,
        });
      }
    }
  }
}

// ── 6 · a mounted service the edge cannot reach ─────────────────────────────
// svc-indexer mounted its router correctly and answered on its own port, but
// the edge had no route to it, so every call 404'd at the door. From outside,
// that is indistinguishable from the service being broken — and from inside,
// the service looks perfect. A service reachable only from within the compose
// network is not reachable.
if (compose !== null) {
  const edgeBlock = /^  svc-edge:([\s\S]*?)(?=^  \S|\Z)/m.exec(compose);
  const edgeEnv = edgeBlock?.[1] ?? '';
  const routes = read('services/svc-edge/src/routes.ts') ?? '';

  for (const svc of services) {
    const index = read(`services/${svc}/src/index.ts`);
    // Only services that actually serve a router need a route to them.
    if (!index?.includes('register(fastifyTRPCPlugin')) continue;
    if (svc === 'svc-edge') continue;

    /**
     * Read the ROUTE ENTRIES, not the first brace pair that mentions the name.
     *
     * This previously ran `new RegExp('\\{[^}]*<name>[^}]*\\}')` across the whole
     * file and took the first hit. That matches ANY brace pair — including the
     * `Upstream` interface and the comments inside it. As soon as a comment near
     * the top mentioned `trade` (#186 added one explaining the new `module`
     * field), the check matched that block, found no `envVar`, and reported
     * "svc-trade mounts a tRPC router but has no entry in UPSTREAMS" — while the
     * entry sat plainly at line 62 and the edge answered 200 for it.
     *
     * It went red on `main` for everyone, on prose. A gate that fails on a
     * comment is worse than no gate, because it teaches people to ignore it —
     * and the next failure it reports will be a real one.
     *
     * So: consider only brace pairs that ASSIGN `envVar` a string literal —
     * `envVar: '…'`. Note the quote is load-bearing. My first attempt matched
     * `envVar:` alone, which still selected the `Upstream` interface, because
     * the interface *declares* `readonly envVar: string`. A value has quotes; a
     * type does not. That distinction is the whole check.
     */
    const entries = routes.match(/\{[^{}]*envVar: '[^{}]*\}/g) ?? [];
    const needle = svc.replace('svc-', '').toLowerCase();
    const entry = entries.find((e) => e.toLowerCase().includes(needle));
    const envVar = /envVar: '(\w+)'/.exec(entry ?? '')?.[1];

    if (!envVar) {
      failures.push({
        file: 'services/svc-edge/src/routes.ts',
        reason: `${svc} mounts a tRPC router but has no entry in UPSTREAMS — callers get a 404 from the edge while the service itself is healthy and answering`,
      });
    } else if (!edgeEnv.includes(`${envVar}:`)) {
      failures.push({
        file: 'docker-compose.apps.yml',
        reason: `svc-edge's route table names ${envVar} for ${svc}, but its compose block does not set it — the edge falls back to a localhost dev URL that resolves to the edge container itself`,
      });
    }
  }
}

// ── 7 · a service with a database has a role that actually exists ───────────
// `tooling/infra/postgres-init/01-service-schemas.sql` creates one role and one
// schema per service — but Postgres runs `/docker-entrypoint-initdb.d` ONLY on
// an EMPTY data directory. So adding a service to that array does nothing for
// anyone whose volume already exists, and FORGETTING to add it does nothing
// visible until a clean clone.
//
// The failure it produces is the reason this check is worth its length: the
// role does not exist, so `postgres://svc_newthing:svc_newthing@…` comes back
// as `28P01` — which the driver reports as a PASSWORD authentication failure.
// Everyone who reads that goes looking for a wrong credential in compose. The
// credential is right; the account it names was never created. That mistake
// has an entire onboarding session's worth of cost attached to it.
//
// Static, at the commit, before anyone builds a volume around it.
const initSql = read('tooling/infra/postgres-init/01-service-schemas.sql');
const composeRoles = new Map(); // svc-name -> role named in its DATABASE_URL
if (compose !== null) {
  for (const [, name, body] of compose.matchAll(/^  ([a-z0-9-]+):([\s\S]*?)(?=^  \S|\Z)/gm)) {
    const role = /DATABASE_URL: postgres:\/\/([a-z0-9_]+):/.exec(body)?.[1];
    if (role) composeRoles.set(name, role);
  }
}
if (initSql === null) {
  if (composeRoles.size > 0) {
    failures.push({
      file: 'tooling/infra/postgres-init/01-service-schemas.sql',
      reason:
        'missing entirely, but compose names database roles — every service with a DATABASE_URL would fail to authenticate on a clean clone',
    });
  }
} else {
  // The array holds the SUFFIX (`'identity'`), the URL holds the full role
  // (`svc_identity`). Compare on the full name so a typo in either is caught.
  const declared = new Set([...initSql.matchAll(/'([a-z0-9_]+)'/g)].map(([, s]) => (s.startsWith('svc_') ? s : `svc_${s}`)));
  for (const [svc, role] of composeRoles) {
    if (!declared.has(role)) {
      failures.push({
        file: 'tooling/infra/postgres-init/01-service-schemas.sql',
        reason: `${svc} connects as "${role}" but that role is not in the bootstrap array — on a clean clone the role does not exist and the connection fails with 28P01, which reads as a wrong PASSWORD rather than a missing account`,
      });
    }
  }
}

// ── 8 · a service with a schema has a migration, and it is actually run ─────
// Three separate places have to agree before a service's tables exist:
// compose gives it a DATABASE_URL, `tooling/infra/migrate-all.mjs` lists it, and
// the service ships migration files. Any two out of three is silent.
//
// Missing from migrate-all: the migration never runs, so the schema is empty,
// and the service's boot assertion (`SELECT 1 FROM <schema>.<table>`, which
// every service with a database performs) fails with "relation does not exist"
// — read by everyone as a broken query in the service, not as a runner that was
// never asked to run.
//
// The reverse is quieter still: migration files with no DATABASE_URL in compose
// means someone wrote a schema that the fleet will never create, and nothing
// fails at all until the first query.
const migrateAll = read('tooling/infra/migrate-all.mjs') ?? '';
for (const svc of services) {
  const hasUrl = composeRoles.has(svc);
  const migrations = migrationCount(svc);

  if (hasUrl && migrations === 0) {
    failures.push({
      file: `services/${svc}/drizzle`,
      reason: `${svc} is given a DATABASE_URL but ships no migration — its schema stays empty and its boot assertion fails with "relation does not exist", which reads as a broken query rather than a missing migration`,
    });
  }
  if (hasUrl && !migrateAll.includes(`'${svc}'`)) {
    failures.push({
      file: 'tooling/infra/migrate-all.mjs',
      reason: `${svc} has a DATABASE_URL but is not in the SERVICES list — the migrate container exits 0 without touching its schema, and every service gated on service_completed_successfully starts anyway`,
    });
  }
  if (!hasUrl && migrations > 0) {
    failures.push({
      file: 'docker-compose.apps.yml',
      reason: `${svc} ships ${migrations} migration(s) but its compose block sets no DATABASE_URL — those tables are never created in the fleet`,
    });
  }
}

// ── 9 · a *_URL that names a service the fleet does not contain ─────────────
// Check 5's blind spot, and it is the same shape as the bug that widened it.
// That check compares the port in a `*_URL` against the port the named service
// listens on — but it can only do that for a service it can FIND. When the name
// is wrong, or the service was renamed, `listens` has no entry and check 5 says
// nothing at all.
//
// The runtime symptom is worse than a wrong port, not better: a wrong port is
// ECONNREFUSED from a host that exists, while a wrong NAME does not resolve in
// the compose network at all. Both containers stay healthy either way, so the
// fleet is green and only the calls fail.
if (compose !== null) {
  const known = new Set([...compose.matchAll(/^  ([a-z0-9-]+):/gm)].map(([, n]) => n));

  for (const [, caller, body] of compose.matchAll(/^  ([a-z0-9-]+):([\s\S]*?)(?=^  \S|\Z)/gm)) {
    for (const [, varName, svc] of body.matchAll(/(\w+_URL): http:\/\/(svc-[a-z0-9-]+):\d+/g)) {
      if (!known.has(svc)) {
        failures.push({
          file: 'docker-compose.apps.yml',
          reason: `${caller} calls "${svc}" via ${varName}, but no service by that name exists in this compose — the hostname does not resolve, so every request through that route fails while both containers report healthy`,
        });
      }
    }
  }
}

// ── 10 · every edge route has a URL, in BOTH the places one can be wrong ────
// Check 6 arrives at the env var from the service side, by matching a service
// name against the route table. That works for the services it can match and is
// blind to any UPSTREAMS row it cannot — a prefix whose service was renamed, or
// one that fans out to a path rather than a service. Walking UPSTREAMS itself is
// exhaustive by construction, which is the property that matters in a gate.
//
// The `devUrl` half is the literal bug that produced check 5: INDEXER_URL named
// 4012 while svc-indexer listens on 4013. Compose is now guarded against that;
// `devUrl` is not, and it is what a developer running the edge OUTSIDE compose
// actually hits. A dev fallback pointing at the wrong port is a live service
// answering a DIFFERENT API — which does not fail cleanly, it answers wrongly.
//
// An unset env var is reported by both 6 and 10, from the two directions. That
// duplication is deliberate: neither check subsumes the other (6 also catches a
// mounted service with NO route table entry, which 10 cannot see), so deleting
// either to silence the second line reopens a gap.
if (compose !== null) {
  const edgeBlock = /^  svc-edge:([\s\S]*?)(?=^  \S|\Z)/m.exec(compose);
  const edgeEnv = edgeBlock?.[1] ?? '';
  const routes = read('services/svc-edge/src/routes.ts');

  if (routes === null) {
    failures.push({ file: 'services/svc-edge/src/routes.ts', reason: 'missing entirely — the front door has no route table' });
  } else {
    for (const [, prefix, envVar, devUrl] of routes.matchAll(/\{\s*prefix: '([^']+)',\s*envVar: '(\w+)',\s*devUrl: '([^']+)'/g)) {
      const deployed = new RegExp(`${envVar}: http://(svc-[a-z0-9-]+):(\\d+)`).exec(edgeEnv);
      if (!deployed) {
        failures.push({
          file: 'docker-compose.apps.yml',
          reason: `svc-edge routes ${prefix} via ${envVar}, but its compose block does not set it — the edge falls back to ${devUrl}, a localhost URL that inside the container resolves to the edge itself`,
        });
        continue;
      }
      const devPort = /:(\d+)/.exec(devUrl)?.[1];
      if (devPort && devPort !== deployed[2]) {
        failures.push({
          file: 'services/svc-edge/src/routes.ts',
          reason: `${envVar}'s dev fallback is ${devUrl} but compose points it at ${deployed[1]}:${deployed[2]} — one of the two is wrong, and running the edge outside compose would reach whatever else holds port ${devPort}`,
        });
      }
    }
  }
}

// ── 7 · a user-facing app that cannot be run ────────────────────────────────
//
// The failure this exists for, in full, because it cost four days:
//
// The vendored trading shell is the stated product — 74 screens, and the
// direction has always been that our features go on top of it. It had no
// `dist`, no Dockerfile and no compose entry. The only way to see it was
// `npm run dev` by hand. Documents sent readers to `:8090`; nothing ever served
// that port.
//
// So one developer put 48 commits into it WITHOUT EVER SEEING IT RENDER, while
// a different app — added two days before the shell was vendored — stayed on
// :3000 as the de-facto product purely because it was the only one that
// started. Nobody chose that. It is what happens when the intended thing cannot
// be run and the unintended thing can.
//
// No gate caught it, because every gate here asked "does this service reach the
// fleet?" and a front-end is not a service.
//
// So: a directory with a build script is a thing somebody expects to be able to
// look at, and it either appears in compose or carries a written `# no-deploy:`
// reason. Silence is the thing being forbidden.
//
// The trigger is the build script ALONE — deliberately, and not because a
// tighter test was unavailable. Requiring an `index.html` or a Next config too
// would read as more precise and would fail in the direction that has no
// remedy: a front-end this gate does not recognise is silent again, which is
// the entire bug. A false positive costs one `# no-deploy:` line with a reason,
// which is a sentence someone should have written anyway.
{
  const composeApps = read('docker-compose.apps.yml') ?? '';
  // Two views of the same file, and the asymmetry is deliberate.
  //
  // "Is it deployed?" is answered against CONFIG only — comment lines removed.
  // The test is a substring match on the directory, and this file is heavily
  // commented (rightly), so prose that merely MENTIONS a front-end would
  // otherwise satisfy it. That is the quiet direction of the same bug: a gate
  // reporting deployed because someone wrote a paragraph about the thing they
  // did not deploy. The `no-deploy` block below this one is exactly such a
  // paragraph.
  //
  // "Was a reason written?" is answered against the RAW text, because a written
  // reason IS a comment. Blank comments for both and the escape hatch stops
  // working; keep them for both and the escape hatch is accidental.
  //
  // Full-line comments only — a `#` mid-line can be inside a YAML value.
  const composeConfig = composeApps
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
  // Vendored front-ends are DISCOVERED, not named — see `vendoredPackages`
  // above for why (brand-scan §0.7, and a second vendored tree must not
  // escape), and for the discovery bug that made this line return nothing at
  // all for the first two days of this check's life.
  const vendored = vendoredPackages();
  const frontends = [...workspacesUnder('apps').map((n) => ({ name: n, dir: join('apps', n) })), ...vendored];

  // The bug this check just came back from was not a wrong answer. It was a
  // right answer to nothing: `vendoredPackages`'s predecessor returned `[]`,
  // every loop below ran zero times, and the gate printed a tick. Discovery
  // silently returning empty is the failure mode, so it is now stated rather
  // than assumed — and the counts go on the summary line, so the next time
  // coverage collapses it is visible in the passing output instead of only in
  // the failing output.
  //
  // The two directions are not the same fault and do not get the same answer:
  //
  //  - `vendor/` is THERE and the walk found nothing in it — since the Vue
  //    front end was deleted (2026-10-19) that is the expected state. Say so
  //    out loud, as below, so nobody reads a tick as coverage.
  //  - `vendor/` is not there at all — a legitimate end state if the vendored
  //    shell is ever fully retired. Pass, but say so out loud, so nobody reads
  //    a tick as coverage. That is the `fabricated-money-scan` (deleted 2026-10-13) rule.
  if (!existsSync(join(ROOT, 'vendor'))) {
    console.log('  · workspace-sync check 7: no vendor/ directory — NO VENDORED FRONT-END WAS INSPECTED.');
    console.log('    If the vendored shell still exists, discovery is broken; fix vendoredPackages rather than ignoring this line.');
  } else if (vendored.length === 0) {
    // 2026-10-19: the vendored Vue front end was deleted; what remains under vendor/ is Java and
    // scripts, with no package.json. That is the true state, not broken discovery. A vendored
    // front end that returns carries a package.json and is walked again by `vendoredPackages`.
    console.log('  · workspace-sync check 7: vendor/ holds no package.json (Java only) — NO VENDORED FRONT-END WAS INSPECTED.');
  }
  vendoredInspected = vendored.length;

  for (const fe of frontends) {
    if (!existsSync(join(ROOT, fe.dir, 'package.json'))) continue;
    frontendsInspected++;
    // Repo-relative, forward slashes. CI is Linux; half of us are on Windows,
    // and a reported path nobody can paste back is a reported path nobody acts
    // on. Only for MESSAGES — `fe.dir` stays platform-native for the fs calls.
    const shown = fe.dir.split(sep).join('/');

    // A vendored manifest is upstream's file, not ours. An unparseable one used
    // to throw out of the whole gate — which loses every other failure in this
    // run behind a stack trace that names no check. Report it and continue.
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(ROOT, fe.dir, 'package.json'), 'utf8'));
    } catch (err) {
      failures.push({
        file: `${shown}/package.json`,
        reason: `cannot be parsed (${err.message}) — this check cannot tell whether it builds a user-facing app, so it is reported rather than skipped`,
      });
      continue;
    }
    if (!pkg.scripts?.build) continue;

    // `\s` inside a template literal is just the letter s — the first version
    // of this line matched nothing and flagged apps/admin, which is plainly in
    // the file. A gate that cries wolf gets switched off, and then the real
    // failure it was written for goes through it unnoticed. Both `\\s` below
    // survive the template literal as `\s`; the mutation battery proves it by
    // adding an app and watching this fire.
    //
    // The path match ends at a path boundary. A bare `includes` is satisfied by
    // any LONGER name that starts the same way, so a sibling directory left
    // behind by a rename — `…/05_Web_Front_old` — would report the real one as
    // deployed. Found by a mutation that meant to delete the shell from compose
    // and accidentally only renamed it, which the gate then called clean.
    const boundary = new RegExp(`${escapeRe(shown)}(?![\\w.-])`);
    const named = boundary.test(composeConfig) || new RegExp(`^\\s{2}${escapeRe(fe.name)}:`, 'm').test(composeConfig);
    if (!named && !composeApps.includes(`# no-deploy: ${fe.name}`)) {
      failures.push({
        file: 'docker-compose.apps.yml',
        reason: `${shown} builds a user-facing app but nothing in the fleet serves it — so it can be worked on for weeks without anyone seeing it, while whichever app DOES start becomes the product by default. If that is deliberate, add "# no-deploy: ${fe.name}" saying why`,
      });
    }
  }
}

// ── 11 · local up --build / staging digest --no-build (D26-P2-04) ───────────
// Hot-patch + compose up without --build leaves yesterday's bytes running.
// Unqualified intafaced/app:dev Hub-pulls if the tag is missing. The proof
// script is the law; this spawn is how verify/CI see it without a second gate
// list. A missing script is a failure, not a skip.
{
  const proof = join(ROOT, 'tooling', 'scripts', 'fleet-tip-image.mjs');
  if (!existsSync(proof)) {
    failures.push({
      file: 'tooling/scripts/fleet-tip-image.mjs',
      reason: 'D26-P2-04 proof missing — fleet tip-image law has no executable check',
    });
  } else {
    const r = spawnSync(process.execPath, [proof], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      const detail = (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n')[0];
      failures.push({
        file: 'tooling/scripts/fleet-tip-image.mjs',
        reason: `D26-P2-04 fleet tip-image law failed: ${detail}`,
      });
    }
  }
}

if (failures.length === 0) {
  // The counts, not just the tick.
  //
  // `✓ workspace-sync clean — 0 service(s) reach both the image and the fleet`
  // was a PASSING line, and check 7 printed a tick for two days while looking at
  // an empty list. A gate that reports what it opened cannot make that claim
  // quietly: the number is on the line every run, so coverage collapsing is
  // visible in the green output rather than only in the red.
  console.log(
    `  ✓ workspace-sync clean — ${services.length} service(s) reach both the image and the fleet ` +
      `(${copyPathsChecked} Dockerfile COPY source(s), ${frontendsInspected} front-end(s) inspected, ${vendoredInspected} of them vendored)`,
  );
  process.exitCode = 0;
} else {
  console.error(`  ✖ workspace-sync — ${failures.length} problem(s)`);
  for (const f of failures) console.error(`        · ${f.file}: ${f.reason}`);
  console.error('\n  A service that exists but does not deploy is not shipped (Doctrine §0.1).');
  process.exitCode = 1;
}
