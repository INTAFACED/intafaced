#!/usr/bin/env node
/**
 * SECRET ROTATION READINESS — D26-P3-05
 *
 * The tip runbook must exist, name the rotatable classes, cite
 * OWNER-ACTIONS-WALLET-RPC-SECRETS.md (without that file being edited here),
 * and the secret and parity gates must stay wired.
 *
 * This scan never reads a secret value. It asserts inventory + citations +
 * that the code guards named in the runbook are still present.
 *
 * Empty denominator: missing runbook → refuse. A deleted inventory is not
 * "nothing to rotate".
 *
 * Usage:
 *   node tooling/ci/secret-rotation-readiness-scan.mjs
 *   node tooling/ci/secret-rotation-readiness-scan.mjs --self-test
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

export const RUNBOOK_REL = 'docs/SECRET-ROTATION-READINESS.md';
export const OWNER_ACTIONS_REL = 'docs/OWNER-ACTIONS-WALLET-RPC-SECRETS.md';
export const GATES_REL = 'tooling/ci/gates.mjs';
export const PARITY_REL = 'tooling/ci/compose-secret-parity.mjs';

/** Env names the runbook must mention. Values must never appear in the runbook. */
export const REQUIRED_ENV_NAMES = [
  'EDGE_PRINCIPAL_SECRET',
  'INTERNAL_SERVICE_SECRET',
  'NOTIFY_EMAIL_GATEWAY_TOKEN',
  'NOTIFY_PUSH_GATEWAY_TOKEN',
  'NOTIFY_SMS_GATEWAY_TOKEN',
  'ECT_WITHDRAW_WALLET_SECRET',
  'WALLET_RPC_AUTH_TOKEN',
];

export const REQUIRED_RUNBOOK_PHRASES = ['OWNER-ACTIONS-WALLET-RPC-SECRETS.md', 'compose-secret-parity', 'Class X'];

const HEX64 = /\b[0-9a-f]{64}\b/i;
const PEM_OR_HEX_KEY = /-----BEGIN |0x[0-9a-fA-F]{64}/;

/**
 * @param {{
 *   runbook?: string | null,
 *   ownerActionsExists?: boolean,
 *   gatesSource?: string | null,
 *   parityExists?: boolean,
 * }} files
 * @returns {string[]}
 */
export function evaluate(files) {
  const failures = [];
  const runbook = files.runbook;
  if (runbook == null || runbook.trim() === '') {
    failures.push(`${RUNBOOK_REL} is missing — cannot prove rotation readiness (empty denominator)`);
    return failures;
  }

  if (files.ownerActionsExists === false) {
    failures.push(`${OWNER_ACTIONS_REL} is missing — runbook must cite it; this scan does not rewrite that file`);
  }

  for (const name of REQUIRED_ENV_NAMES) {
    if (!runbook.includes(name)) {
      failures.push(`${RUNBOOK_REL} must name rotatable env ${name} (no values)`);
    }
  }
  for (const phrase of REQUIRED_RUNBOOK_PHRASES) {
    if (!runbook.includes(phrase)) {
      failures.push(`${RUNBOOK_REL} must cite ${phrase}`);
    }
  }
  if (!/order of rotation/i.test(runbook) && !/^## 2 · Order of rotation/m.test(runbook)) {
    failures.push(`${RUNBOOK_REL} must include an order-of-rotation section`);
  }
  if (!runbook.includes('A1') || !runbook.includes('A2')) {
    failures.push(`${RUNBOOK_REL} must cite OWNER-ACTIONS A1 and A2 (A2 is a different account)`);
  }

  if (HEX64.test(runbook) || PEM_OR_HEX_KEY.test(runbook)) {
    failures.push(`${RUNBOOK_REL} must not contain 64-hex digests, PEM, or 0x hot keys`);
  }

  const gates = files.gatesSource ?? '';
  for (const id of ['compose-secret-parity', 'secrets', 'secret-rotation-readiness']) {
    if (!gates.includes(`id: '${id}'`)) {
      failures.push(`${GATES_REL} must keep GATES id '${id}'`);
    }
  }

  if (files.parityExists === false) {
    failures.push(`${PARITY_REL} is missing — rotation recreates containers; unwired secrets crash then`);
  }

  return failures;
}

function readOptional(rel) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function selfTest() {
  const cases = [];
  const okRunbook = [
    '# Secret rotation readiness',
    '## 2 · Order of rotation',
    'OWNER-ACTIONS-WALLET-RPC-SECRETS.md A1 A2',
    'EDGE_PRINCIPAL_SECRET INTERNAL_SERVICE_SECRET',
    'NOTIFY_EMAIL_GATEWAY_TOKEN NOTIFY_PUSH_GATEWAY_TOKEN NOTIFY_SMS_GATEWAY_TOKEN',
    'ECT_WITHDRAW_WALLET_SECRET WALLET_RPC_AUTH_TOKEN',
    'compose-secret-parity Class X',
  ].join('\n');
  const okGates = ["id: 'compose-secret-parity'", "id: 'secrets'", "id: 'secret-rotation-readiness'"].join('\n');

  cases.push({
    name: 'missing runbook refuses',
    files: { runbook: null, ownerActionsExists: true, gatesSource: okGates, parityExists: true },
    expectFail: true,
    needle: 'missing',
  });
  cases.push({
    name: 'runbook without EDGE_PRINCIPAL_SECRET refuses',
    files: {
      runbook: okRunbook.replace('EDGE_PRINCIPAL_SECRET ', ''),
      ownerActionsExists: true,
      gatesSource: okGates,
      parityExists: true,
    },
    expectFail: true,
    needle: 'EDGE_PRINCIPAL_SECRET',
  });
  cases.push({
    name: '64-hex in runbook refuses',
    files: {
      runbook: `${okRunbook}\n${'ab'.repeat(32)}`,
      ownerActionsExists: true,
      gatesSource: okGates,
      parityExists: true,
    },
    expectFail: true,
    needle: '64-hex',
  });
  cases.push({
    name: 'complete fixture passes',
    files: {
      runbook: okRunbook,
      ownerActionsExists: true,
      gatesSource: okGates,
      parityExists: true,
    },
    expectFail: false,
  });

  let failed = 0;
  for (const c of cases) {
    const hits = evaluate(c.files);
    const didFail = hits.length > 0;
    const needleOk = !c.needle || hits.some((h) => h.includes(c.needle));
    if (didFail !== c.expectFail || (c.expectFail && !needleOk)) {
      failed++;
      console.error(`  FAIL ${c.name}: expected fail=${c.expectFail} needle=${c.needle ?? '-'} got ${JSON.stringify(hits)}`);
    }
  }
  if (failed > 0) {
    console.error(`SECRET ROTATION READINESS SELF-TEST FAILED — ${failed}/${cases.length} cases`);
    process.exit(1);
  }
  console.log(`secret-rotation-readiness self-test: ${cases.length}/${cases.length} cases`);
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }

  const runbookPath = join(ROOT, RUNBOOK_REL);
  if (!existsSync(runbookPath)) {
    console.error(
      'SECRET ROTATION READINESS FAILED — docs/SECRET-ROTATION-READINESS.md is missing.\n' +
        'Cannot prove what must be rotatable or that disclosed values stay refused. This is not a clean bill of health.',
    );
    process.exit(1);
  }

  const failures = evaluate({
    runbook: readFileSync(runbookPath, 'utf8'),
    ownerActionsExists: existsSync(join(ROOT, OWNER_ACTIONS_REL)),
    gatesSource: readOptional(GATES_REL),
    parityExists: existsSync(join(ROOT, PARITY_REL)),
  });

  if (failures.length > 0) {
    console.error(`SECRET ROTATION READINESS FAILED — ${failures.length} problem(s):\n`);
    for (const f of failures) console.error(`  · ${f}`);
    process.exit(1);
  }

  console.log(
    'secret-rotation-readiness: runbook names rotatable classes, cites OWNER-ACTIONS-WALLET-RPC-SECRETS.md, ' +
      'and the secret and compose-parity gates remain wired (no secret values read).',
  );
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
