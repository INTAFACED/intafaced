#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * KILL-SWITCH REACHABILITY — §14.6, machine-checked.
 *
 * The DoD gate listed "Kill-switch verified reachable from `apps/admin`" as a
 * MANUAL sign-off item. Manual is how it stayed false for so long: every piece
 * of the platform's kill-switch machinery existed and was correct, and none of
 * it was connected to anything.
 *
 *   · `packages/config/src/flags.ts` modelled `disabledModules` from the start.
 *   · `svc-protocol` exported `setRelayEnabled`, `svc-indexer` exported
 *     `setIngestEnabled`, both commented "the kill-switch surface `apps/admin`
 *     reaches" — module-scope functions callable from no other process.
 *   · `svc-ledger` built the money-plane freeze properly: a durable
 *     `posting_freeze` row, an `actor` column, a `posting_freeze_attributed_ck`
 *     constraint, and `admin:treasury` on the procedures. Then never mounted the
 *     router, so nothing could call them.
 *   · `apps/admin` printed "Staged changes are held in this browser session and
 *     have not been sent anywhere", and `operator-commands.ts` said of the
 *     ledger controls: "They do NOT call them."
 *
 * A checkbox cannot catch that. Each assertion below is one specific way the
 * wire can be cut again, chosen because it HAS been cut that way.
 *
 * Deliberately structural rather than behavioural: the behaviour is proved by
 * `services/svc-edge/src/control-plane.e2e.test.ts`, which pulls the switch over
 * real HTTP and watches the platform refuse. This script's job is to fail if
 * that proof stops existing.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const failures = [];

const read = (...parts) => {
  const file = join(ROOT, ...parts);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
};

/**
 * Is `name(app…)` actually CALLED, rather than merely mentioned?
 *
 * The first version of this script tested the raw source with a regex, and a
 * negative test caught it out immediately: commenting the call out left the
 * text on the line, the regex still matched, and the gate reported the switch
 * wired while it was not. Which is precisely the class of failure this whole
 * file exists to catch — a control that looks present and is not.
 *
 * So comment lines are dropped before the test. Block comments are handled the
 * same way; both files this is used on are ordinary TypeScript with
 * conventional formatting, and the check is deliberately narrow rather than a
 * parser.
 */
const callsWithApp = (source, name) => {
  let inBlock = false;
  const code = source
    .split('\n')
    .filter((raw) => {
      const line = raw.trim();
      if (inBlock) {
        if (line.includes('*/')) inBlock = false;
        return false;
      }
      if (line.startsWith('/*')) {
        if (!line.includes('*/')) inBlock = true;
        return false;
      }
      return !(line.startsWith('//') || line.startsWith('*'));
    })
    .join('\n');
  // Matched over the comment-stripped SOURCE, not line by line. Prettier puts
  // `app` on its own line once a call gains a fourth argument (325e91a43 did
  // exactly that to svc-ledger's `registerOperatorHttp`), and a per-line test
  // then reported a mounted surface as unmounted. `\s*` spans the newline.
  return new RegExp(`(^|[^\\w.])${name}\\s*\\(\\s*app\\b`, 'm').test(code);
};

// Read once, up here: assertions 1b and 4 both need it.
const adminApi = read('services', 'svc-edge', 'src', 'admin-api.ts');

// ── 1 · No route can be un-killable ─────────────────────────────────────────
//
// `/api/v1` is the public CCXT REST contract and forwards to svc-trade, but the
// prefix does not spell "trade". A kill-switch map derived from the prefix
// STRING left it unmapped, so halting `trade` refused the tRPC order path while
// `POST /api/v1/orders` kept taking new risk — with the console showing
// "trade: killed" throughout.
const routes = read('services', 'svc-edge', 'src', 'routes.ts');
if (!routes) {
  failures.push('services/svc-edge/src/routes.ts is missing — the edge route table is where killability is decided');
} else {
  const entries = [...routes.matchAll(/\{\s*prefix:\s*'([^']+)'([^}]*)\}/g)];
  if (entries.length === 0) {
    failures.push('services/svc-edge/src/routes.ts declares no upstreams — the route table could not be parsed');
  }
  for (const [, prefix, rest] of entries) {
    if (!/\bmodule:\s*'[^']+'/.test(rest)) {
      failures.push(
        `svc-edge route "${prefix}" declares no \`module\` — it could never be killed (§14.6). ` +
          'State the module explicitly; do not derive it from the prefix.',
      );
    }
  }
}

// ── 1b · No module can be ARMED that the edge cannot ENFORCE ────────────────
//
// Assertion 1 proves every edge ROUTE names a module. It says nothing about the
// other direction, and that is where the hole was: `admin-api.ts` accepted a
// kill for every one of the 23 `MODULE_IDS`, while the edge can only refuse the
// 13 that have a prefix in the route table.
//
// So an operator could halt `ws`, receive 200, and read `disabledModules:
// ["ws"]` back from `/admin/status` while svc-ws kept serving — svc-ws publishes
// 4014 and the browser connects to it directly. A halt that returns 200, lands
// in the audit trail and refuses nothing is exactly the failure this file exists
// to catch, and the gate printed "every route killable" throughout.
//
// The invariant: {modules the console can arm} ⊆ {modules the edge can enforce}.
if (adminApi && (!/ENFORCEABLE_MODULES/.test(adminApi) || !/OUTSIDE_THE_DOOR/.test(adminApi))) {
  failures.push(
    'svc-edge/src/admin-api.ts does not restrict kill-switch toggles to modules the edge can enforce — ' +
      'the toggle schema must reject any module with no prefix in the route table (ENFORCEABLE_MODULES / OUTSIDE_THE_DOOR ' +
      'from routes.ts). Arming a switch that refuses nothing is worse than having none (§14.6).',
  );
}

// ── 1c · Nothing is deployed OUTSIDE the door without being recorded ────────
//
// "Enforced at the door" only holds if the door is the only way in. The
// kill-switch is an `onRequest` hook on svc-edge, so it can refuse exactly what
// svc-edge serves; a service the browser reaches on its own published port is
// not behind the hook and no amount of edge code can stop it.
//
// This is the check that makes the property survive the NEXT service. Publish a
// host port, and the gate fails until that service either goes behind the edge
// or is consciously recorded in `OUTSIDE_THE_DOOR` with a reason — at which
// point the control plane refuses to pretend it can be halted.
const compose = read('docker-compose.apps.yml');
if (!compose) {
  failures.push('docker-compose.apps.yml is missing — the gate cannot tell which services are reachable outside the edge');
} else if (routes) {
  // Parsed line-wise rather than with one big regex. A `[\s\S]*?` spanning a
  // YAML block is exactly how a scan starts matching the NEXT service's `ports:`
  // and reports the wrong container.
  const published = [];
  let current = null;
  let inServices = false;
  for (const line of compose.split('\n')) {
    if (/^services:/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    // A non-indented line ends the `services:` block (`volumes:`, `networks:`…).
    if (/^[A-Za-z]/.test(line)) {
      inServices = false;
      continue;
    }
    const svc = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (svc) {
      current = svc[1];
      continue;
    }
    if (current && /^ {4}ports:/.test(line)) published.push(current);
  }

  if (published.length === 0) {
    failures.push(
      'docker-compose.apps.yml — no published ports could be parsed, so the outside-the-door check would pass vacuously. ' +
        'Fix the parser rather than trusting the green.',
    );
  }

  // The `module:` values actually present in the route table.
  const routed = new Set([...routes.matchAll(/\bmodule:\s*'([^']+)'/g)].map(([, m]) => m));
  // `OUTSIDE_THE_DOOR` keys, read from the object literal rather than assumed.
  const block = /OUTSIDE_THE_DOOR[^=]*=\s*\{([\s\S]*?)\n\};/.exec(routes);
  const outside = new Set(block ? [...block[1].matchAll(/^ {2}([a-z][a-z0-9-]*):/gm)].map(([, m]) => m) : []);

  for (const container of published) {
    // `web`, `admin` and `vendor-shell` are browser pages, not platform modules.
    if (!container.startsWith('svc-')) continue;
    const module = container.slice('svc-'.length);
    if (module === 'edge') continue; // the door itself
    if (routed.has(module)) continue; // behind the door, therefore killable
    if (outside.has(module)) continue; // consciously recorded as a known gap
    failures.push(
      `${container} publishes a host port but has no prefix in svc-edge/src/routes.ts. The kill-switch is an onRequest ` +
        `hook on the edge, so it cannot refuse traffic that never crosses the edge — "${module}" is UNKILLABLE (§14.6). ` +
        'Route it through the edge, or record it in OUTSIDE_THE_DOOR with a reason so the console refuses to pretend.',
    );
  }
}

// ── 2 · The switch is enforced at the door, and fails closed ────────────────
const controlPlane = read('services', 'svc-edge', 'src', 'control-plane.ts');
if (!controlPlane) {
  failures.push('services/svc-edge/src/control-plane.ts is missing — nothing enforces the operator kill-switch');
} else {
  if (!/addHook\(\s*'onRequest'/.test(controlPlane)) {
    failures.push(
      'the kill-switch is not an `onRequest` hook in control-plane.ts — a guard inside one handler protects that handler, not the door',
    );
  }
  // Fail closed. This is the assertion that matters most: a safety control which
  // opens when its own check errors is worse than no control at all.
  if (!/catch[\s\S]{0,200}refused:\s*true/.test(controlPlane)) {
    failures.push('control-plane.ts does not refuse when the kill-switch check throws — a safety control MUST fail closed (§14.6)');
  }
  if (!/registerAdminRoutes/.test(controlPlane)) {
    failures.push('control-plane.ts registers no admin routes — apps/admin would have nothing to reach');
  }
}

// ── 3 · The edge actually registers both, from the same module ──────────────
//
// If `index.ts` re-implemented the routes inline, the e2e suite would verify a
// parallel copy of the rule and the deployed process would run an unverified one.
const edgeIndex = read('services', 'svc-edge', 'src', 'index.ts');
if (!edgeIndex) {
  failures.push('services/svc-edge/src/index.ts is missing');
} else {
  for (const fn of ['registerKillSwitchGuard', 'registerAdminRoutes']) {
    if (!callsWithApp(edgeIndex, fn)) {
      failures.push(`svc-edge/src/index.ts never calls ${fn}(app, …) — the control plane is not wired into the running edge`);
    }
  }
}

// ── 4 · The operator control plane is authorised ────────────────────────────
//
// An operator control any authenticated user can reach is not a control.
if (!adminApi) {
  failures.push('services/svc-edge/src/admin-api.ts is missing — the control plane has no authorisation');
} else {
  for (const scope of ['admin:write', 'admin:treasury']) {
    if (!adminApi.includes(scope)) {
      failures.push(
        `svc-edge/src/admin-api.ts does not require "${scope}" — halting a market and halting the money plane are different authorities`,
      );
    }
  }
  if (!/requireMfa|INTERACTIVE_ONLY/.test(adminApi)) {
    failures.push('svc-edge/src/admin-api.ts enforces no second factor on operator actions (§9)');
  }
}

// ── 5 · The money-plane freeze is mounted ───────────────────────────────────
//
// svc-ledger had `freeze`/`unfreeze` behind `admin:treasury` on a router that
// was exported for its TYPE and served on no port. Correct code, reachable by
// nothing.
const ledgerIndex = read('services', 'svc-ledger', 'src', 'index.ts');
if (!ledgerIndex) {
  failures.push('services/svc-ledger/src/index.ts is missing');
} else if (!callsWithApp(ledgerIndex, 'registerOperatorHttp')) {
  failures.push(
    'svc-ledger does not mount its operator surface — `posting_freeze` is durable and attributed but unreachable, ' +
      'so the platform emergency stop needs a redeploy (§4.2, §14.6)',
  );
}

// ── 6 · apps/admin can reach it ─────────────────────────────────────────────
if (!read('apps', 'admin', 'src', 'lib', 'control-plane-client.ts')) {
  failures.push('apps/admin has no control-plane client — §14.6 requires the kill-switch be reachable FROM apps/admin');
}
for (const route of ['kill-switch', 'ledger-freeze']) {
  if (!read('apps', 'admin', 'src', 'app', 'api', route, 'route.ts')) {
    failures.push(`apps/admin/src/app/api/${route}/route.ts is missing — the console cannot reach that switch`);
  }
}

// ── 7 · The behavioural proof still exists ──────────────────────────────────
//
// The asymmetry is the whole point: halting a market stops new risk, it does not
// confiscate positions, and a user must always be able to get out. Both halves
// must be asserted or the test proves half a control.
const e2e = read('services', 'svc-edge', 'src', 'control-plane.e2e.test.ts');
if (!e2e) {
  failures.push('services/svc-edge/src/control-plane.e2e.test.ts is missing — the kill-switch has no end-to-end proof');
} else {
  const required = [
    ['REFUSES a new order', 'that a halted market refuses new orders'],
    ['STILL LETS A USER CANCEL', 'that a halted market still lets a user out'],
    ['edge.kill_switch_undecidable', 'that an errored switch check behaves as engaged'],
    ['admin:treasury', 'that the money-plane freeze needs its own authority'],
    ['previous:', 'that the audit trail records the prior state'],
    // D26-P2-10 — every money module killable from the same surface, proven.
    ['money modules — same kill surface (D26-P2-10)', 'that every live money module is armed from /admin/kill-switches'],
    ['REFUSES each money module sample door once killed', 'that pay/bank/p2p/token/market/trade refuse under kill'],
    // Deepen: residual doors (convert/withdraw/loans/agents) — not just first-pass samples.
    ['/api/trade/trpc/convert.execute', 'that convert is proved under the shared kill surface'],
    ['/api/agents/trpc/run.complete', 'that agents metering is killable from the same surface'],
  ];
  for (const [needle, what] of required) {
    if (!e2e.includes(needle)) {
      failures.push(`control-plane.e2e.test.ts no longer asserts ${what} ("${needle}" not found)`);
    }
  }

  // Named unit matrix over MONEY_PUBLIC_DOORS — structural twin of the e2e suite.
  const moneyUnit = read('services', 'svc-edge', 'src', 'money-routes.kill-switch.test.ts');
  if (!moneyUnit) {
    failures.push(
      'services/svc-edge/src/money-routes.kill-switch.test.ts is missing — D26-P2-10 money-route kill matrix has no unit proof',
    );
  } else {
    for (const [needle, what] of [
      ['MONEY_PUBLIC_DOORS', 'that the unit suite walks the config money-door catalogue'],
      ['refuses every named money commitment when that module is killed', 'that every catalogue door refuses under kill'],
      ['covers remaining money routes after prior land', 'that residual money doors stay covered after #1683'],
      ['MONEY_KILL_RESIDUAL_DOOR_IDS', 'that the residual door id list is asserted'],
    ]) {
      if (!moneyUnit.includes(needle)) {
        failures.push(`money-routes.kill-switch.test.ts no longer asserts ${what} ("${needle}" not found)`);
      }
    }
  }

  const moneySurface = read('packages', 'config', 'src', 'money-kill-surface.ts');
  if (!moneySurface || !/MONEY_PUBLIC_DOORS/.test(moneySurface)) {
    failures.push('packages/config/src/money-kill-surface.ts is missing MONEY_PUBLIC_DOORS — money kill completeness has no catalogue');
  } else {
    for (const [needle, what] of [
      ['MONEY_KILL_RESIDUAL_DOOR_IDS', 'that residual money door ids are named'],
      ['assertMoneyKillResidualsPresent', 'that residual completeness is machine-checked'],
      ['trade.convert.execute', 'that convert is in the money kill catalogue'],
      ['pay.withdrawal.create', 'that withdrawal is in the money kill catalogue'],
      ['agents.run.complete', 'that agents metering is in the money kill catalogue'],
      ['assertMoneyRoutesHaveKillMapping', 'that an unmapped money prefix fails closed'],
    ]) {
      if (!moneySurface.includes(needle)) {
        failures.push(`money-kill-surface.ts no longer covers ${what} ("${needle}" not found)`);
      }
    }
  }

  /**
   * …and it must actually RUN.
   *
   * Every assertion above is satisfied by a file whose suites are skipped: the
   * strings are still there, the gate still greps them, and the behaviour is
   * proved by nothing. `describe.skip`, `it.todo` or a `skipIf` on an env var
   * that is unset in CI would all leave this gate green over a kill-switch no
   * one has pulled since it was written — which is the state §14.6 started in.
   */
  const skipped = e2e.match(/\b(?:describe|it|test)\.(?:skip|todo|skipIf|runIf|concurrent\.skip)\b/g);
  if (skipped) {
    failures.push(
      `control-plane.e2e.test.ts contains ${skipped.length} skipped/conditional suite(s) (${[...new Set(skipped)].join(', ')}) — ` +
        'the kill-switch proof must run unconditionally. A gate that greps a test it never runs has proved nothing (§14.6).',
    );
  }
}

// ── 8 · A new money route without a kill mapping fails this gate (D26-P2-10) ─
//
// Assertion 1 proves every prefix *names* a module. That is not a kill mapping:
// `/api/pay/v2` can say `module: 'pay'` and still be absent from MONEY_PUBLIC_DOORS,
// so the prove suite never walks it and an operator cannot show the door refuses.
// Catalogue rows are opt-in until this check: parse live UPSTREAMS, require every
// money-module prefix to have at least one catalogue path under it.
{
  const moneySurface = read('packages', 'config', 'src', 'money-kill-surface.ts');
  if (!moneySurface) {
    failures.push('packages/config/src/money-kill-surface.ts is missing — money-route kill mapping has no catalogue');
  } else {
    if (!/assertMoneyRoutesHaveKillMapping/.test(moneySurface)) {
      failures.push(
        'money-kill-surface.ts is missing assertMoneyRoutesHaveKillMapping — the fail-closed mapping check is not in the catalogue module',
      );
    }
    const modulesSrc = read('packages', 'config', 'src', 'modules.ts') ?? '';
    const custodial = new Set();
    for (const m of modulesSrc.matchAll(/id:\s*'([a-z][a-z0-9-]*)'[\s\S]*?custodial:\s*(true|false)/g)) {
      if (m[2] === 'true') custodial.add(m[1]);
    }
    if (custodial.size === 0) {
      failures.push('modules.ts custodial ids could not be parsed — money-route mapping would skip every prefix');
    }
    // agents bills via ledger recipes — same kill surface even though custodial:false.
    const moneyModules = new Set([...custodial, 'agents']);

    const doorRows = [...moneySurface.matchAll(/\{\s*id:\s*'([^']+)',\s*module:\s*'([^']+)',\s*method:\s*'[^']+',\s*path:\s*'([^']+)'/g)];
    if (doorRows.length === 0) {
      failures.push('MONEY_PUBLIC_DOORS could not be parsed — a mapping check that sees zero doors would pass vacuously');
    }

    const pathUnder = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

    if (routes) {
      const upstreams = [...routes.matchAll(/\{\s*prefix:\s*'([^']+)'([^}]*)\}/g)].map(([, prefix, rest]) => {
        const m = /\bmodule:\s*'([^']+)'/.exec(rest);
        return { prefix, module: m ? m[1] : '' };
      });
      if (upstreams.length === 0) {
        failures.push('UPSTREAMS could not be parsed for money-route kill mapping');
      }
      for (const u of upstreams) {
        if (!moneyModules.has(u.module)) continue;
        if (u.module === 'ledger') {
          failures.push(`money route prefix "${u.prefix}" maps to ledger — halt the book at /admin/ledger/freeze, not an /api prefix`);
          continue;
        }
        const covering = doorRows.filter(([, , module, path]) => module === u.module && pathUnder(path, u.prefix));
        if (covering.length === 0) {
          failures.push(
            `money route prefix "${u.prefix}" (module ${u.module}) has no kill mapping in MONEY_PUBLIC_DOORS — ` +
              'a new money door that is not in the catalogue cannot be proved killable from /admin/kill-switches (D26-P2-10)',
          );
        }
      }
      for (const [, id, module, path] of doorRows) {
        const match = [...upstreams].filter((u) => pathUnder(path, u.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
        if (!match) {
          failures.push(`money door "${id}" path ${path} matches no edge prefix — unmapped`);
        } else if (match.module !== module) {
          failures.push(`money door "${id}" path ${path} resolves to ${match.prefix} (${match.module}), catalogue says ${module}`);
        }
      }
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.log('✖ kill-switch reachability (§14.6)');
  for (const f of failures) console.log(`    · ${f}`);
  process.exit(1);
}

/**
 * The message says what was CHECKED, not what we would like to be true.
 *
 * The previous line read "every route killable, enforced at the door, fails
 * closed, reachable from apps/admin" — while the script checked none of those
 * end to end. It greps structure; the behaviour is proved by
 * `control-plane.e2e.test.ts` under `pnpm test`, which assertion 7 now also
 * requires to actually run. "Every route killable" was the outright false half:
 * the console could arm ten modules the edge cannot enforce, and svc-ws was
 * serving the browser on its own port the whole time.
 */
console.log('✓ kill-switch reachability (§14.6, structural)');
console.log('    · every edge route names a module; only enforceable modules can be armed');
console.log('    · guard is an onRequest hook wired into the running edge, with a fail-closed catch');
console.log('    · nothing publishes a host port outside the door unrecorded');
console.log('    · the behavioural proof exists and is not skipped — it runs under `pnpm test`');
console.log('    · every live money edge prefix has a MONEY_PUBLIC_DOORS kill mapping (D26-P2-10)');
