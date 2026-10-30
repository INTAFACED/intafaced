#!/usr/bin/env node
/**
 * MUTATION TEST for `secret-scan.mjs`.
 *
 * WHY A MUTATION TEST AND NOT A UNIT TEST
 *
 * A scanner that passes is indistinguishable from a scanner that is switched
 * off. `pnpm scan:secrets` printing a green tick proves nothing on its own —
 * `process.exit(0)` on line 1 would print the same tick. The A1.4 branch
 * (docs/A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md §4) handled this by hand:
 * a probe file with three planted credentials, run once, then deleted. That
 * proved the gate worked on the day it was written and nothing afterwards.
 *
 * This makes it repeatable. Each MUTANT is a small synthetic file with a known
 * defect planted in it. The scan runs against a throwaway git repository
 * containing that one file. A mutant is KILLED if the scan exits non-zero.
 *
 * Two corpora, and the second is the one that matters more:
 *
 *   · `catch: true`  — a real defect. Surviving means the gate is blind to a
 *     class of committed credential.
 *   · `catch: false` — correct code that is credential-SHAPED. Killing one of
 *     these is a false positive, and a gate that cries wolf gets disabled. This
 *     file's whole reason for existing is that the second number stays at zero
 *     while the first goes up.
 *
 * Mutants marked `knownGap: true` are expected to survive and are excluded from
 * the score. They are documented non-goals — printed every run so a gap has to
 * be re-read rather than forgotten. Silently scoring them as passes would be
 * the same dishonesty as exempting a path to make a build green.
 *
 * NO MUTANT CONTAINS A REAL CREDENTIAL. Every planted value is the literal
 * string `MUTANT-` plus filler. That is deliberate: a test corpus is a tracked
 * file like any other, and seeding it with realistic secrets to test a secret
 * scanner is how you end up with a secret in the repository.
 *
 * Usage:  pnpm scan:secrets:mutate
 * Exit 0 = every scored mutant behaved. Exit 1 = a survivor or a false positive.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCAN = resolve(dirname(fileURLToPath(import.meta.url)), 'secret-scan.mjs');

/** Filler that is long enough to clear MIN_SOURCE_LITERAL_LENGTH and announces itself. */
const V = 'MUTANT-not-a-real-credential-0000';

/** A password that is shaped like an environment-variable NAME but carries digits. */
const DIGIT_BEARING_UPPER_SNAKE = 'PROD_ADMIN_PW_2026_XK9Q';
/** A route that looks like a Slack webhook: the secret is the last segments. */
/** A route that looks like a Telegram bot endpoint: the token sits in the first segment. */
const TELEGRAM_BOT_SHAPED_PATH = `/bot123456789:AAH${V}/sendMessage`;
const SLACK_WEBHOOK_SHAPED_PATH = `/services/T0AAAA/B0BBBB/${V}`;

/**
 * @typedef {object} Mutant
 * @property {string}  id
 * @property {string}  file      path inside the synthetic repo — the path matters,
 *                               `01_wallet_rpc` and `.test.ts` change the rules
 * @property {string}  content
 * @property {boolean} catch     true = the scan must fail on this
 * @property {boolean} [knownGap] expected survivor, excluded from the score
 * @property {string}  why
 */

/** @type {Mutant[]} */
const MUTANTS = [
  // ── config: the original rules, kept under test so a refactor cannot quietly
  //    drop what already worked ────────────────────────────────────────────────
  {
    id: 'properties-literal',
    file: 'svc/application.properties',
    content: `server.port=8080\nspring.redis.password=${V}\n`,
    catch: true,
    why: 'credential-shaped key assigned a literal — the original rule',
  },
  {
    id: 'properties-env-placeholder',
    file: 'svc/application.properties',
    content: 'spring.redis.password=${COINEX_REDIS_PASSWORD}\n',
    catch: false,
    why: '${VAR} with no default is the outcome the gate wants',
  },
  {
    id: 'compose-required-var',
    file: 'docker-compose.yml',
    content: 'services:\n  a:\n    environment:\n      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET:?missing}\n',
    catch: false,
    why: '${VAR:?msg} is STRONGER than ${VAR} — compose refuses to start. Regressing this was one of the three bugs A1.4 found in its own first draft',
  },
  {
    id: 'compose-weak-default',
    file: 'docker-compose.yml',
    content: `services:\n  a:\n    environment:\n      REDIS_PASSWORD: \${REDIS_PASSWORD:-${V}}\n`,
    catch: true,
    why: 'a credential with a default boots insecurely instead of failing loudly — perimeter finding P3',
  },
  {
    id: 'yaml-inline-url-credential',
    file: 'conf/app.yml',
    content: `uri: mongodb://operator:${V}@10.0.0.5:27017/wallet\n`,
    catch: true,
    why: 'the MongoDB URI shape — a credential the key-name rule alone cannot see',
  },
  {
    id: 'matched-dev-pair-url',
    file: 'conf/app.yml',
    content: 'url: postgres://svc_trade:svc_trade@postgres:5432/intafaced\n',
    catch: false,
    why: 'password identical to username discloses nothing — the repo convention',
  },
  {
    id: 'test-database-url-token-key',
    file: '.env.example',
    content: 'TEST_DATABASE_URL_TOKEN=postgres://svc_token:svc_token@localhost:5433/intafaced_test\n',
    catch: false,
    why: 'a *_URL_TOKEN key is a URL, not a token — the NOT_ACTUALLY_SECRET carve-out',
  },
  {
    id: 'json-api-key-literal',
    file: 'conf/settings.json',
    content: `{\n  "apiKey": "${V}"\n}\n`,
    catch: true,
    why: 'JSON config is scanned like any other config file',
  },
  {
    id: 'i18n-bundle-prose',
    file: 'src/i18n/messages_zh_CN.properties',
    content: 'member.password.error=Password is incorrect\n',
    catch: false,
    why: 'i18n values are prose; scanning them is one false positive per string per language',
  },

  {
    id: 'json-tokens-file-path-list',
    file: 'apps/admin/.21st/design.json',
    content:
      '{\n  "sources": {\n    "tokens": ["src/app/globals.css", "../../packages/ui/src/tokens.css"],\n    "components": []\n  }\n}\n',
    catch: false,
    why: 'a `tokens` key listing design-token SOURCE FILES (the 21st design-context file) is a list of paths, not a credential',
  },
  {
    id: 'json-tokens-literal-list',
    file: 'conf/settings.json',
    content: `{\n  "tokens": ["${V}"]\n}\n`,
    catch: true,
    why: 'the file-path carve-out must not become a way to hide a credential in a list: no `/`, no extension, still a finding',
  },
  {
    id: 'json-tokens-path-list-with-secret',
    file: 'conf/settings.json',
    content: `{\n  "tokens": ["src/app/globals.css", "${V}"]\n}\n`,
    catch: true,
    why: 'ONE non-path element is enough to keep the whole list a finding',
  },
  {
    id: 'json-password-path-shaped-list',
    file: 'conf/settings.json',
    content: `{\n  "password": ["p@ss/${V}.k9"]\n}\n`,
    catch: true,
    why: 'the file-path carve-out is for the key `tokens` only: a path-shaped value under `password` is still a credential',
  },
  {
    id: 'yaml-api-key-path-shaped-list',
    file: 'conf/settings.yml',
    content: `api_key: ["x/${V}.abc"]\n`,
    catch: true,
    why: 'the file-path carve-out is for the key `tokens` only: a path-shaped value under `api_key` is still a credential',
  },
  {
    id: 'json-tokens-url-with-credentials',
    file: 'conf/settings.json',
    content: `{\n  "tokens": ["https://u:${V}@h/a.json"]\n}\n`,
    catch: true,
    why: 'a URL carrying user:password@ is not a file path even when it ends in an extension',
  },

  // ── source: everything below was invisible to the gate before 2026-08-03 ─────
  {
    id: 'java-credential-literal',
    file: 'src/main/java/com/x/RegisterController.java',
    content: `public class RegisterController {\n    private static final String secretKey = "${V}";\n}\n`,
    catch: true,
    why: 'THE NEW FINDING: a third-party key pair hard-coded in a controller of a published, running jar',
  },
  {
    id: 'java-private-key-field',
    file: 'src/main/java/com/x/GeetestLib.java',
    content: `public class GeetestLib {\n\tprivate String privateKey = "${V}";\n}\n`,
    catch: true,
    why: 'a second copy of a secret the owner is already rotating — rotating the env var does not remove it',
  },
  {
    id: 'java-camelcase-password',
    file: 'src/main/java/com/x/Wallet.java',
    content: `class Wallet {\n    String withdrawWalletPassword = "${V}";\n}\n`,
    catch: true,
    why: 'camelCase identifiers must normalise to the same rule as snake_case keys',
  },
  {
    id: 'ts-api-key-literal',
    file: 'src/client.ts',
    content: `export const apiKey = '${V}';\n`,
    catch: true,
    why: 'TypeScript is source too — the fleet is mostly TypeScript',
  },
  {
    id: 'java-inline-url-in-test',
    file: 'src/test/java/ActClientTest.java',
    content: `public class ActClientTest {\n    public static void main(String[] a) {\n        new ActClient("http://act:${V}@203.0.113.7:8900/rpc");\n    }\n}\n`,
    catch: true,
    why: 'the ACT finding. A test CAN disclose something real by naming a real host, so the URL rule deliberately still runs in test files',
  },
  {
    id: 'ts-test-fixture-secret',
    file: 'src/router.mount.test.ts',
    content: "const SECRET = 'a-bank-mount-test-edge-secret-long-enough';\n",
    catch: false,
    why: 'a credential-shaped constant in a test is a fixture by construction — 29 of 33 identifier hits repo-wide, and the reason the identifier rule skips test files',
  },
  {
    id: 'java-redis-key-prefix',
    file: 'src/main/java/com/x/SysConstant.java',
    content: 'public class SysConstant {\n    public static final String RESET_PASSWORD_CODE_PREFIX = "reset:password:code:";\n}\n',
    catch: false,
    why: 'a Redis key prefix, not a credential — the ends-with rule is what keeps this quiet',
  },
  {
    id: 'java-token-name-field',
    file: 'src/main/java/com/x/SessionStrategy.java',
    content: 'class SessionStrategy {\n    private String tokenName = "x-auth-token";\n}\n',
    catch: false,
    why: 'a header NAME, not a token value. Bare `token` is excluded from the source rule for exactly this',
  },
  {
    id: 'java-assignment-from-call',
    file: 'src/main/java/com/x/Login.java',
    content: 'class Login {\n    void f() {\n        String password = request.getParameter("password");\n    }\n}\n',
    catch: false,
    why: 'assignment FROM something is not a committed literal — only a literal can be committed',
  },
  {
    id: 'comment-with-credential-url',
    file: 'src/main/java/com/x/Doc.java',
    content: '/** URLs carrying inline credentials: scheme://user:password@host */\nclass Doc {}\n',
    catch: false,
    why: "the scan's own doc comment used to fail the scan. Block comments are skipped like // and #",
  },

  // ── the wallet tree ─────────────────────────────────────────────────────────
  {
    id: 'wallet-signing-literal',
    file: 'vendor/exchange/01_wallet_rpc/ect/src/main/java/com/x/EctApi.java',
    content: `class EctApi {\n    public static void main(String[] a) {\n        String txid = api.sendFrom("${V}", "from", "to");\n    }\n}\n`,
    catch: true,
    why: 'THE WORST SHAPE IN THE REPO: a main() that signs a real transfer with a constant. No identifier and no URL to key off',
  },
  {
    id: 'wallet-kafka-send-topic',
    file: 'vendor/exchange/01_wallet_rpc/eth-support/src/main/java/com/x/PaymentHandler.java',
    content: 'class PaymentHandler {\n    void f() {\n        kafkaTemplate.send("wallet-payment-topic", name, json);\n    }\n}\n',
    catch: false,
    why: 'bare send() is a generic verb — excluding it is why the signing rule finds one hit and not three',
  },
  {
    id: 'wallet-withdraw-seed',
    file: 'vendor/exchange/01_wallet_rpc/ect/src/main/resources/application.properties',
    content: `coin.withdraw-wallet=${V}\n`,
    catch: true,
    why: 'the ECT withdrawal seed under a key name that is harmless everywhere else — SECRET_BY_CONVENTION exists for this one line',
  },
  {
    id: 'wallet-withdraw-keystore-filename',
    file: 'vendor/exchange/01_wallet_rpc/eth/src/main/resources/application.properties',
    content: 'coin.withdraw-wallet=UTC--2019-01-01T00-00-00.0Z--abcdef\n',
    catch: false,
    why: 'the SAME key in the ETH family holds a keystore filename. Same name, opposite sensitivity',
  },
  {
    id: 'wallet-keystore-password-env',
    file: 'vendor/exchange/01_wallet_rpc/eth/src/main/resources/application.properties',
    content: 'coin.withdraw-wallet-password=${ETH_WITHDRAW_WALLET_PASSWORD}\n',
    catch: false,
    why: 'the refusal-to-boot shape A1.4 installed across 22 files. Killing this would mean the gate was punishing the fix',
  },

  // ── prefixed assignments: found as survivors by this file, then closed ──────
  {
    id: 'dockerfile-env-literal',
    file: 'Dockerfile',
    content: `FROM node:20\nENV API_KEY=${V}\n`,
    catch: true,
    why: '`ENV KEY=value` is `key=value` wearing a prefix. Survived the first mutation run; the leading-keyword strip closed it',
  },
  {
    id: 'dockerfile-env-benign',
    file: 'Dockerfile',
    content: 'FROM node:20\nENV NODE_ENV=production\n',
    catch: false,
    why: 'the only ENV lines in this repo set PATH, NODE_ENV and a port — closing the gap above had to cost nothing here',
  },
  {
    id: 'shell-export-literal',
    file: 'deploy/release.sh',
    content: `#!/bin/sh\nexport API_KEY=${V}\n`,
    catch: true,
    why: 'a deploy script is exactly where a curl credential ends up. Also a first-run survivor',
  },
  {
    id: 'shell-export-benign',
    file: 'deploy/release.sh',
    content: '#!/bin/sh\nexport PLAYWRIGHT_BROWSERS_PATH=/tmp/pw\n',
    catch: false,
    why: 'the real exports in tooling/uiproof/run-pass3.sh must stay quiet',
  },

  // ── documented non-goals ────────────────────────────────────────────────────
  {
    id: 'high-entropy-under-innocent-key',
    file: 'svc/application.properties',
    content: 'coin.node-identifier=a3f9c1e8b7d24f6a9e0c5b8d1f4a7c2e\n',
    catch: true,
    knownGap: true,
    why: 'GAP BY DESIGN: catching this needs entropy heuristics, which fire on minified bundles, lockfile hashes and git SHAs. The scan header rejects them explicitly and that judgement stands',
  },
  {
    id: 'java-env-var-name-constant',
    file: 'src/main/java/com/x/ServiceAuth.java',
    content: 'public final class ServiceAuth {\n    public static final String SECRET_ENV = "INTERNAL_SERVICE_SECRET";\n}\n',
    catch: false,
    why: 'a constant holding the NAME of an environment variable (…_ENV = UPPER_SNAKE) is the pointer the gate asks for, not a secret',
  },
  {
    id: 'java-env-constant-with-real-secret',
    file: 'src/main/java/com/x/ServiceAuth.java',
    content: `public final class ServiceAuth {\n    public static final String SECRET_ENV = "${V}";\n}\n`,
    catch: true,
    why: 'the env-name carve-out needs UPPER_SNAKE: a lower/mixed-case literal behind the same identifier is still a finding',
  },
  {
    id: 'java-env-constant-digit-bearing-upper-snake',
    file: 'src/main/java/com/x/ServiceAuth.java',
    content: `public final class ServiceAuth {\n    public static final String SECRET_ENV = "${DIGIT_BEARING_UPPER_SNAKE}";\n}\n`,
    catch: true,
    why: 'env-var NAMES are letters and underscores only here: a digit-bearing UPPER_SNAKE value is a password that looks like a name',
  },
  {
    id: 'ts-route-path-constant',
    file: 'src/auth/api-key-ownership-route.ts',
    content: "export const API_KEY_OWNERSHIP_PATH = '/internal/api-keys' as const;\n",
    catch: false,
    why: 'a *_PATH constant holding a /-rooted HTTP route is a URL path, not a key',
  },
  {
    id: 'ts-path-constant-with-real-secret',
    file: 'src/auth/api-key-ownership-route.ts',
    content: `export const API_KEY_OWNERSHIP_PATH = '${V}';\n`,
    catch: true,
    why: 'the route carve-out needs a leading slash AND route characters: a credential behind the same identifier is still a finding',
  },
  {
    id: 'ts-path-constant-slash-rooted-secret',
    file: 'src/auth/api-key-ownership-route.ts',
    content: `export const API_KEY_OWNERSHIP_PATH = '/${V}';\n`,
    catch: true,
    why: 'a leading slash is not enough: route segments are lowercase words only, so a slash-rooted credential is still a finding',
  },
  {
    id: 'ts-webhook-path-with-token',
    file: 'src/notify/slack.ts',
    content: `export const SECRET_WEBHOOK_PATH = '${SLACK_WEBHOOK_SHAPED_PATH}';\n`,
    catch: true,
    why: 'a Slack-webhook-shaped path carries its secret in the last segments; mixed-case and digit-bearing segments are not route words',
  },
  {
    id: 'ts-api-token-url-bot-path',
    file: 'src/notify/telegram.ts',
    content: `export const API_TOKEN_URL = '${TELEGRAM_BOT_SHAPED_PATH}';\n`,
    catch: true,
    why: 'a credential-named identifier STARTING with api_token/auth_token is a credential identifier; a Telegram bot path carries its token in the URL',
  },
  {
    id: 'java-password-env-upper-snake-passphrase',
    file: 'src/main/java/com/x/ServiceAuth.java',
    content: 'public final class ServiceAuth {\n    public static final String PASSWORD_ENV = "CORRECT_HORSE_BATTERY_STAPLE";\n}\n',
    catch: true,
    knownGap: true,
    why: 'GAP BY DESIGN: a letters-only UPPER_SNAKE value behind `*_ENV` is indistinguishable from an environment-variable NAME, so a passphrase written that way is exempt',
  },
  {
    id: 'ts-secret-webhook-url-lowercase-token',
    file: 'src/notify/hooks.ts',
    content: "export const SECRET_WEBHOOK_URL = '/hooks/qwhzkxpmvbtnrlsd';\n",
    catch: true,
    knownGap: true,
    why: 'GAP BY DESIGN: an all-lowercase token as the only path segment is indistinguishable from a route word, so a lowercase secret route segment is exempt',
  },
  {
    id: 'ts-url-constant-with-versioned-route',
    file: 'src/auth/api-key-routes.ts',
    content: "export const API_KEY_ROTATE_URL = '/v1/api-keys/{keyId}/rotate';\n",
    catch: false,
    why: 'versioned, hyphenated and {param} route segments are still a route, not a key',
  },
  {
    id: 'actions-cache-key',
    file: '.github/actions/test-infra/action.yml',
    alsoTracked: { 'packages/x/pom.xml': '<project/>\n' },
    content:
      "steps:\n  - uses: actions/cache@v6\n    with:\n      path: x/.tools\n      key: java-tools-x-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('packages/x/pom.xml') }}\n",
    catch: false,
    why: 'an actions/cache key built from dash-joined words, runner.os/arch and hashFiles of tracked files is a cache name, not a credential',
  },
  {
    id: 'actions-cache-key-digit-literal',
    file: '.github/actions/test-infra/action.yml',
    alsoTracked: { 'packages/x/pom.xml': '<project/>\n' },
    content: "steps:\n  - with:\n      key: tok3n9xq7-${{ hashFiles('packages/x/pom.xml') }}\n",
    catch: true,
    why: 'the cache-key carve-out allows only lowercase letter words before the expressions: a digit-bearing lowercase credential is still a finding',
  },
  {
    id: 'actions-cache-key-secret-as-hashfiles-path',
    file: '.github/actions/test-infra/action.yml',
    content: `steps:\n  - with:\n      key: tools-\${{ hashFiles('${V}') }}\n`,
    catch: true,
    why: 'every hashFiles argument must be a file the repo tracks: a credential written as the "path" is still a finding',
  },
  {
    id: 'actions-cache-key-without-hashfiles',
    file: '.github/actions/test-infra/action.yml',
    content: 'steps:\n  - with:\n      key: tools-${{ runner.os }}\n',
    catch: true,
    why: 'the carve-out needs at least one hashFiles: a bare `key` with only a runner expression is outside it',
  },
  {
    id: 'actions-cache-key-input-reference',
    file: '.github/workflows/build.yml',
    alsoTracked: { 'packages/x/pom.xml': '<project/>\n' },
    content: "jobs:\n  b:\n    steps:\n      - with:\n          key: tools-${{ inputs.token }}-${{ hashFiles('packages/x/pom.xml') }}\n",
    catch: true,
    why: 'only runner.os, runner.arch and hashFiles expressions are a cache key: an inputs reference behind `key` is still a finding',
  },
  {
    id: 'cache-key-shape-outside-github',
    file: 'tooling/infra/tls.yml',
    alsoTracked: { 'packages/x/pom.xml': '<project/>\n' },
    content: "tls:\n  key: java-tools-${{ hashFiles('packages/x/pom.xml') }}\n",
    catch: true,
    why: 'the cache-key carve-out applies under .github/ only: the same shape in any other config is still a finding',
  },
];

// ── runner ───────────────────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'secret-scan-mutation-'));
const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });

/** Run the scan against a one-file synthetic repo. Returns true if it failed (= mutant killed). */
function scanFails(mutant) {
  const repo = mkdtempSync(join(root, 'r-'));
  try {
    git(['init', '-q'], repo);
    const abs = join(repo, mutant.file);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, mutant.content, 'utf8');
    for (const [rel, content] of Object.entries(mutant.alsoTracked ?? {})) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), content, 'utf8');
    }
    git(['add', '-A', '-f'], repo);
    try {
      execFileSync(process.execPath, [SCAN], {
        cwd: repo,
        stdio: 'pipe',
        // The register names files that do not exist in a synthetic repo, so its
        // staleness rule would fire on every mutant. Disabling it is strictly
        // stricter — see secret-scan.mjs.
        env: { ...process.env, SECRET_SCAN_NO_REGISTER: '1' },
      });
      return false; // exit 0 — survived
    } catch {
      return true; // non-zero — killed
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const survivors = [];
const falsePositives = [];
const knownGaps = [];

try {
  for (const m of MUTANTS) {
    const failed = scanFails(m);
    if (m.knownGap) {
      knownGaps.push({ ...m, stillGap: !failed });
      continue;
    }
    if (m.catch && !failed) survivors.push(m);
    if (!m.catch && failed) falsePositives.push(m);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const scored = MUTANTS.filter((m) => !m.knownGap);
const shouldCatch = scored.filter((m) => m.catch);
const shouldPass = scored.filter((m) => !m.catch);
const killed = shouldCatch.length - survivors.length;
const clean = shouldPass.length - falsePositives.length;
const pct = (n, d) => (d === 0 ? '100.0' : ((n / d) * 100).toFixed(1));

const failed = survivors.length > 0 || falsePositives.length > 0;
// Retired gaps are as important as open ones: a gap that closed itself means an
// entry is lying about the gate's coverage and should be deleted.
const retiredGaps = knownGaps.filter((g) => !g.stillGap);
// One line when green, because this runs inside the DoD gate next to eight other
// scans. The detail is there the moment anything is wrong.
const verbose = failed || retiredGaps.length > 0 || process.argv.includes('--verbose');

if (verbose) {
  console.log('\n  secret-scan mutation test\n');
  console.log(`  detection       ${killed}/${shouldCatch.length} planted defects caught   (${pct(killed, shouldCatch.length)}%)`);
  console.log(
    `  false positives ${falsePositives.length}/${shouldPass.length} correct files rejected   (${pct(clean, shouldPass.length)}% clean)`,
  );
  console.log(`  documented gaps ${knownGaps.length} excluded from the score\n`);

  for (const g of knownGaps) {
    console.log(`  ${g.stillGap ? '·' : '✓'} gap [${g.id}] ${g.stillGap ? 'still open' : 'NOW COVERED — retire this entry'}`);
    console.log(`      ${g.why}`);
  }
  if (knownGaps.length > 0) console.log('');
}

if (survivors.length > 0) {
  console.error(`  ✖ ${survivors.length} planted defect(s) SURVIVED — the gate is blind to these:\n`);
  for (const m of survivors) console.error(`      [${m.id}] ${m.file}\n        ${m.why}\n`);
}
if (falsePositives.length > 0) {
  console.error(`  ✖ ${falsePositives.length} correct file(s) were REJECTED — this is how a gate gets disabled:\n`);
  for (const m of falsePositives) console.error(`      [${m.id}] ${m.file}\n        ${m.why}\n`);
}

if (failed) process.exit(1);
console.log(
  `✓ secret-scan mutation test — ${killed}/${shouldCatch.length} planted defects caught, ` +
    `${falsePositives.length} false positive(s) across ${shouldPass.length} correct files, ` +
    `${knownGaps.length} documented gap(s)`,
);
