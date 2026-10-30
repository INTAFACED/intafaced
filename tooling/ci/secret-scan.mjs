#!/usr/bin/env node
/**
 * SECRET SCAN — no credential-shaped literal in a tracked file.
 *
 * WHY THIS RULE EXISTS, in the words of what actually happened here.
 *
 * The vendored Java platform arrived with ~40 credentials sitting in tracked
 * `application.properties` files: Redis passwords, an SMTP password, cloud
 * access key pairs, SMS gateway passwords, captcha private keys, MongoDB URIs
 * with embedded credentials, block-explorer API keys, a signing-key password.
 *
 * One of them was not decoration. `security.user.password` guarded the Spring
 * Boot actuator on a service whose port is published to 0.0.0.0. Anyone holding
 * a copy of this repository could authenticate to `/uc/monitor/heapdump` and
 * download the entire process heap — every secret in memory, every in-flight
 * user record. That was proven against the running fleet, not theorised.
 *
 * The lesson is not "be careful with secrets". It is that a committed credential
 * is invisible: it reviews as a config line, it survives every rebrand, and the
 * day it becomes reachable nobody re-reads the file. So the check is mechanical.
 *
 * WHAT IT ENFORCES
 *
 * For every assignment whose KEY looks like a credential (password, secret,
 * token, api key, access key, private key), the VALUE must be one of:
 *
 *   1. An environment placeholder — `${VAR}`. The service reads it from the
 *      environment and, because there is no `:-default`, refuses to start
 *      without it. This is the outcome we want.
 *   2. Empty. Nothing to leak.
 *   3. An obvious, self-declaring placeholder (see PLACEHOLDER_VALUES). It has
 *      to announce itself; "hunter2" does not count.
 *
 * Anything else fails. It also flags URLs carrying inline `user:password@`
 * credentials, which the key-name check alone would miss — `spring.data.mongodb.uri`
 * is not a credential-shaped key but it carried one.
 *
 * DELIBERATELY NOT A HIGH-ENTROPY SCANNER. Entropy heuristics fire on minified
 * bundles, lockfile hashes, git SHAs and base64 images, and a gate that cries
 * wolf is a gate people learn to bypass with --no-verify. This checks a narrow
 * thing exactly.
 *
 * ── 2026-08-03: SOURCE FILES ARE NOW SCANNED TOO ────────────────────────────
 *
 * The paragraph above used to say a secret in a `.java`/`.ts` file was "a
 * different, rarer problem". That was wrong, and the A1.4 audit
 * (docs/A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md) only looked like it swept
 * the vendored tree because it swept `.properties`. Reading source found a
 * live third-party captcha key pair hard-coded in a controller of a PUBLISHED,
 * RUNNING jar, and a node credential inside a URL in a test's `main()`. Neither
 * was visible to any gate.
 *
 * Source is scanned, but NOT with the config rules — running the key/value
 * check over ~1,800 source files is the "cries wolf" failure this file's own
 * comments warn about. Source gets three narrow checks instead:
 *
 *   1. `inline-url-credential` — a `scheme://user:pass@host` literal. Runs on
 *      EVERYTHING including test files: a test that embeds a credentialled URL
 *      is pointing at a real host, which is precisely the shape of the ACT and
 *      Mongo findings. Measured across the tree: 2 hits, both genuine.
 *   2. `source-credential-literal` — a credential-NAMED identifier declared
 *      equal to a string literal. Skipped in test files, where such a constant
 *      is a fixture by construction (`const SECRET = 'a-mount-test-secret'`);
 *      scanning them costs one false positive per test file and teaches
 *      nothing. Measured: 33 hits with tests, 4 without, all 4 genuine.
 *   3. `wallet-signing-literal` — under `01_wallet_rpc` only, a string literal
 *      passed positionally into a `sendFrom`/`transfer`/`withdraw` call. No
 *      identifier and no URL to key off; the tell is that a signing call is
 *      being handed a constant. Measured in that tree: 1 hit, genuine.
 *
 * ── THE KNOWN-DISCLOSED REGISTER ────────────────────────────────────────────
 *
 * Widening a gate over a vendored tree you cannot compile means finding things
 * whose FIX is an owner decision, not a code edit. Two bad answers exist:
 * exempt the path (hides it forever) or fail the build (the gate gets deleted
 * within a week). So registered findings are printed loudly on every single run
 * with their rotation-doc reference, and do not fail. Anything NOT registered
 * fails.
 *
 * The register cannot rot: an entry whose file/line no longer produces the
 * violation it claims is itself a FAILURE. You cannot park a finding here and
 * let the code move out from under it.
 *
 * Exit 0 = no unregistered credential-shaped literal is tracked, and every
 * register entry still describes a real finding. Exit 1 = one landed, or the
 * register is stale.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname } from 'node:path';

const ROOT = process.cwd();

/**
 * Config-ish files. Where credentials actually accumulate, and where the full
 * key-name-plus-value rule applies.
 */
const SCANNED_EXTENSIONS = new Set(['.properties', '.yml', '.yaml', '.env', '.conf', '.cfg', '.ini', '.toml', '.json']);

/** Explicitly scanned regardless of extension. */
const SCANNED_BASENAMES = new Set(['.env.example', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml']);

/**
 * Source files. These get the three narrow source checks only — see the header.
 * `.xml` is here for Maven `settings.xml`-shaped credentials and costs nothing;
 * `.sh` because a deploy script is where a curl `-u user:pass` ends up.
 */
const SCANNED_SOURCE_EXTENSIONS = new Set([
  '.java',
  '.kt',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.vue',
  '.go',
  '.py',
  '.rb',
  '.sh',
  '.bash',
  '.xml',
  '.gradle',
]);

/**
 * Test files. The `source-credential-literal` check does not run here, and the
 * reason is not squeamishness about noise for its own sake:
 *
 *   `const SECRET = 'a-bank-mount-test-edge-secret-long-enough'`
 *
 * is a FIXTURE. It has to be credential-shaped or the test is not testing
 * anything, and it authenticates against nothing outside the test process.
 * Across this repo that pattern accounts for 29 of 33 identifier hits — one per
 * mount test — and a gate that fires 29 times on correct code is a gate someone
 * deletes.
 *
 * The inline-URL check still runs on test files, deliberately. A test can only
 * disclose something real by naming a real host, and that is exactly what
 * `01_wallet_rpc/act/src/test/java/ActClientTest.java` does.
 */
const TEST_FILE = /(\.|-)(test|spec)\.[a-z]+$|(^|[\\/])(__tests__|__mocks__)[\\/]|(^|[\\/])src[\\/]test[\\/]|Test\.java$|Tests\.java$/;

/**
 * Paths where a credential-shaped literal is expected and harmless.
 * Every entry needs a reason. "It was noisy" is not a reason.
 */
const EXEMPT_PATHS = [
  { pattern: /(^|[\\/])node_modules[\\/]/, reason: 'third-party dependencies, not our tracked config' },
  { pattern: /(^|[\\/])(dist|build|coverage|\.turbo|\.next)[\\/]/, reason: 'build output' },
  {
    pattern: /(^|[\\/])(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/,
    reason: 'dependency lockfiles — integrity hashes and registry URLs, not credentials',
  },
  {
    pattern: /(^|[\\/])i18n[\\/]|(^|[\\/])(messages|ValidationMessages)_[a-z]{2}_[A-Z]{2}\.properties$/,
    reason:
      'i18n message bundles. Keys like `member.password.error` are UI strings whose VALUE is prose ("Password is incorrect"), not a credential. Scanning them produces one false positive per translated string per language, which is how a gate gets switched off.',
  },
];

/**
 * Values that announce themselves as placeholders. A value matching one of
 * these is allowed to sit in a tracked file because reading it teaches an
 * attacker nothing and a developer everything.
 *
 * `*_dev_only` is the repo's existing convention (see the vendored exchange
 * compose file) and is kept deliberately: those values are matched pairs
 * between compose and the packaged properties, and breaking one half of the
 * pair to satisfy a scanner would be theatre.
 */
const PLACEHOLDER_VALUES = [
  /^\s*$/,
  /^\$\{[^}]+\}$/, // ${VAR} — the outcome we want
  /^\$\{[^}]+:\?[\s\S]*\}$/, // ${VAR:?message} — compose refuses to start without it. STRONGER than ${VAR}; always allowed.
  /^\$\{[^}]+:-[^}]*\}$/, // ${VAR:-default} — allowed here, flagged below if it defaults to something secret-shaped
  //
  // GitHub Actions secret / variable reference — `${{ secrets.NAME }}`.
  //
  // ADDED 2026-08-09 (staging deploy workflow, D26-P3-01). This CLOSES a hole
  // rather than widening the rule.
  //
  // `${{ secrets.X }}` does not match the `${VAR}` pattern above: `[^}]+` cannot
  // cross the inner brace, so `\}$` never reaches the second `}`. The value fell
  // through to `committed-credential` and the gate reported a literal where there
  // is none. Measured against a probe workflow before this line existed:
  //
  //   STAGING_SSH_PRIVATE_KEY: ${{ secrets.STAGING_SSH_PRIVATE_KEY }}
  //   → ✖ [committed-credential] .github/workflows/…:10
  //
  // Wrong on the merits — the value is a reference into GitHub's secret store,
  // there is no literal in the tree, and there is no fallback, which is the
  // outcome the header of this file asks for. Wrong in its effect too: the only
  // ways past it were to rename the secret to something SECRET_KEY does not
  // recognise, or to move the reference into a `run:` body where this scan does
  // not look. Both make a real secret harder to find, and the first is exactly
  // the "breaking one half of the pair to satisfy a scanner would be theatre"
  // trap described a few lines above. A gate that pushes authors toward
  // misnaming their credentials is worse on that line than no gate at all.
  //
  // NARROW ON PURPOSE: one `secrets.` or `vars.` reference, whole value, nothing
  // else in it. The dangerous forms stay failures —
  //
  //   ${{ secrets.A || 'fallback' }}     still fails: a literal, in the tree
  //   ${{ secrets.A }}${{ secrets.B }}   still fails: a composed credential
  //   ${{ inputs.token }}                still fails: an input carries a default
  //   ${{ github.event.inputs.token }}   still fails: attacker-supplied
  //
  /^\$\{\{\s*(?:secrets|vars)\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/,
  /^[a-z0-9_-]*dev[_-]?only[a-z0-9_-]*$/i,
  /^(changeme|change_me|placeholder|example|sample|dummy|redacted|removed|none|null|todo|tbd|xxx+|x{3,})$/i,
  /placeholder/i,
  /^dev-only-/i,
  /^your[_-]/i,
  /^<.*>$/, // <your-key-here>
  /^\*+$/,
  // The value is the generic NOUN for the thing itself — `postgres://user:pw@host/db`
  // in a schema test. It announces itself exactly as loudly as `changeme` does.
  /^(?:pw|pwd|pass|passwd|password|passphrase|secret|creds?|credential|user|username|host|hostname|token|key)$/i,
  // One or two characters. `postgres://u:p@localhost` is a shape, not a credential;
  // nothing two characters long is a credible secret, so treating it as one only
  // trains people to ignore the gate.
  /^.{1,2}$/,
  // YAML anchor declaration (`x-edge-secret: &edge-secret`) or alias (`*edge-secret`).
  // The value on this line is the anchor NAME; the mapping it introduces is on the
  // following lines and is checked there, line by line, like any other assignment.
  /^[&*][A-Za-z0-9_.-]+$/,
];

/**
 * Keys that look like credentials.
 *
 * TWO HOLES WERE MEASURED HERE ON 2026-08-07, against this exact regex:
 *
 *     MISSED  PAY_CRYPTO_HOT_WALLET_KEY     signs every payout
 *     MISSED  PAY_CRYPTO_DEPOSIT_MNEMONIC   derives every deposit address
 *     MISSED  WALLET_SIGNING_KEY
 *     MISSED  STRIPE_SECRET_KEY_LIVE
 *     MISSED  JWT_SIGNING_KEY
 *     CAUGHT  DATABASE_PASSWORD             (control)
 *     CAUGHT  INTERNAL_SERVICE_SECRET       (control)
 *     CAUGHT  API_TOKEN                     (control)
 *
 * Both wallet names are real and in production use — `services/svc-pay/src/env.ts`
 * and `rails/posture.ts`. Commit either into a tracked `.env` or a compose block
 * and this gate printed "clean". For a platform holding crypto that was the most
 * dangerous confirmed finding in the 2026-08-07 audit.
 *
 * 1. `key` was only ever recognised behind a qualifier — `api_key`, `access_key`,
 *    `secret_key`, `private_key`. A bare `_KEY` suffix was not a credential, so
 *    every name a wallet actually uses fell straight through. `key` is now a
 *    credential word ON ITS OWN, which flips this to deny-by-default: an unknown
 *    `*_KEY` is a finding until somebody says otherwise. The business keys that
 *    legitimately end in `_key` are enumerated in NOT_ACTUALLY_SECRET below,
 *    each one narrow and each one reviewable — the same posture the rest of this
 *    file takes. `mnemonic` and `seed`/`seed_phrase` are added for the same
 *    reason: they are how a wallet is spelled, and neither was in the vocabulary.
 *
 * 2. The credential word had to END the name, so a deployment qualifier hid it —
 *    `STRIPE_SECRET_KEY_LIVE` is a live Stripe key and did not match. A trailing
 *    environment/version qualifier is now allowed to follow.
 */
const SECRET_KEY =
  /(?:^|[._-])(?:pass(?:word|wd|phrase)?|secret|token|credential|mnemonic|seed(?:[._-]?phrase)?|key|api[._-]?key|access[._-]?key|secret[._-]?key|private[._-]?key|auth[._-]?token)s?(?:[._-](?:live|test|prod|production|staging|dev|development|sandbox|local|new|old|primary|secondary|v\d+|\d+))*$/i;

/** URLs carrying inline credentials: scheme://user:password@host */
const INLINE_URL_CREDENTIAL = /\b[a-z][a-z0-9+.-]*:\/\/([^\s:/@]+):([^\s@/]+)@/gi;

/**
 * Keys that read as credential-shaped but are not secrets. Narrow by design.
 */
const NOT_ACTUALLY_SECRET = [
  /(?:^|[._-])(?:keys?[._-]to[._-]sanitize)$/i,
  /** GitHub Actions checkout option (`persist-credentials: false`): a boolean switch, never a credential. Exact key only. */
  /^persist-credentials$/i,
  /**
   * BUSINESS KEYS, not credentials.
   *
   * `key` became a credential word on its own so that `*_WALLET_KEY` and
   * `*_SIGNING_KEY` stop being invisible. The cost is every identifier that ends
   * in `_key` and means "identity of a row" rather than "thing that signs" —
   * `idempotencyKey` alone appears throughout the money path.
   *
   * Enumerated rather than pattern-guessed, and each entry requires the word
   * IMMEDIATELY before `key`, so `IDEMPOTENCY_KEY` is exempt while
   * `HOT_WALLET_IDEMPOTENCY_SIGNING_KEY` is not. Deny-by-default: a `_KEY` name
   * that is not on this list is a finding, and adding one here is a reviewable
   * decision with a name attached — which is the posture the rest of this file
   * already takes for allowlists.
   */
  /(?:^|[._-])(?:idempotency|business|dedupe|dedup|cache|routing|partition|sort|primary|foreign|unique|composite|index|object|storage|bucket|record|map|lookup|translation|i18n|locale|licence|license|shortcut|hot)[._-]keys?$/i,
  /** Public by definition — the half of a pair that is meant to be published. */
  /(?:^|[._-])(?:public|pub|verification|verify)[._-]keys?$/i,
  /** Seeding fixtures and RNG, not wallet seeds. */
  /(?:^|[._-])(?:random|rng|fixture|data|market|demo|test)[._-]seeds?$/i,
  /(?:^|[._-])(?:password)[._-](?:null|length|required|invalid|mismatch|hint|label|placeholder)$/i, // i18n strings
  /^sms\.internationalPassword$/i, // always empty upstream; still checked for a value
  /(?:^|[._-])URI?L?(?:[._-]|$)/i, // see below
];

// ── Source-file rules ───────────────────────────────────────────────────────

/**
 * A declaration of an identifier equal to a string literal, in any of the
 * brace languages this repo actually contains:
 *
 *   private static final String secretKey = "…";      (Java)
 *   const SECRET = '…';  let apiKey: string = "…";     (TS/JS)
 *   PASSWORD = "…"                                     (shell/py, via the bare form)
 *
 * Requires a declaration keyword or a type, so `x.password = y` and
 * `{ password: fn() }` do not match — assignment FROM something is not a
 * committed literal, and only a literal can be committed.
 */
const SOURCE_DECLARATION =
  /(?:^|[\s;{(,])(?:(?:private|public|protected|static|final|const|let|var|readonly|String|string|val|export)\s+)+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[A-Za-z<>[\]|\s]+?)?=\s*(["'`])([^"'`\n]*)\2/g;

/**
 * Credential-shaped IDENTIFIERS, which is a different shape from
 * credential-shaped config KEYS: identifiers are camelCase, so the value is
 * snake-normalised (`secretKey` → `secret_Key`) before this is applied.
 *
 * Two alternatives, and the split matters:
 *   · ENDS WITH a credential word — `savedSecret`, `privateKey`, `apiKey`.
 *     Ending is what makes `PHONE_UPDATE_PASSWORD_PREFIX` (a Redis key prefix)
 *     and `tokenName` (a header name) correctly NOT match.
 *   · STARTS WITH one — `secretId`, `secretKey`. Half of a key PAIR is still
 *     half of a key pair; `secretId` is the credential's identifier and leaks
 *     the account it belongs to.
 *
 * Bare `token` is deliberately absent, unlike the config-key rule. In config a
 * key named `token` is a credential; in source `token`/`accessToken` is the
 * JWT plumbing of half this codebase, and including it would fire on every
 * auth file. `authToken`/`apiToken`-shaped names still match.
 */
const SECRET_IDENTIFIER =
  /(?:^|[._$-])(?:pass(?:word|wd|phrase)|secret|secretkey|privatekey|apikey|api_key|accesskey|access_key|credential|authtoken|auth_token|apitoken|api_token)s?$|^(?:secret|password|passphrase|privatekey|private_key|apikey|api_key|accesskey|access_key|apitoken|api_token|authtoken|auth_token)[a-z0-9_$]*$/i;

/**
 * Minimum literal length before a credential-named identifier is a finding.
 * Below this it is a sentinel, a separator or a mask (`""`, `"n/a"`, `"***"`),
 * not a disclosure.
 */
const MIN_SOURCE_LITERAL_LENGTH = 8;

/**
 * A string literal handed positionally to a signing / value-moving call, inside
 * the wallet RPC tree only.
 *
 * This exists for exactly one shape, and it is the worst one in the repository:
 *
 *   public static void main(String[] args) {
 *       api.sendFrom("<seed>", "<from>", "<to>", new BigDecimal("10"), "12");
 *   }
 *
 * There is no identifier to key off and no URL — the tell is that a call which
 * MOVES VALUE is being handed a constant. Restricted to `01_wallet_rpc` because
 * `send(` is a generic verb everywhere else (`kafkaTemplate.send("topic", …)`),
 * and bare `send` is excluded for the same reason. Measured in that tree: one
 * hit, genuine.
 */
const WALLET_SIGNING_TREE = /(^|[\\/])01_wallet_rpc[\\/]/;
const WALLET_SIGNING_LITERAL = /\b(?:sendFrom|sendTo|sendRaw|sendTransaction|transfer|withdraw)[A-Za-z]*\s*\(\s*(["'])([^"'\n]{8,})\1/g;

/**
 * Config keys that are NOT credential-shaped but carry key material anyway.
 * Every entry is a specific, checked claim — this is not a place to guess.
 *
 * `coin.withdraw-wallet` is the whole reason this list exists. In the ETH
 * family it holds a keystore FILENAME (`UTC--2019-…`) and the secret beside it
 * is `coin.withdraw-wallet-password`, already `${ETH_WITHDRAW_WALLET_PASSWORD}`.
 * In `ect` the same key holds the RAW SIGNING SEED, because `EctApi.sendFrom`
 * takes the seed as its `privatekey` argument and POSTs it as a JSON field
 * named `secret` over plain HTTP. Same key name, opposite sensitivity — which
 * is exactly why a key-name rule alone can never find it.
 */
const SECRET_BY_CONVENTION = [
  {
    key: /^coin\.withdraw-wallet$/i,
    /** A keystore filename is not a secret; the password beside it is. */
    allow: /^UTC--/i,
    reason:
      'in the ETH family this is a keystore filename, but in `ect` the same key holds the raw signing seed that `sendFrom` POSTs as `secret` over plain HTTP',
  },
];

/**
 * Why `*URL*` / `*URI*` keys are excluded from the KEY-NAME check specifically:
 * `TEST_DATABASE_URL_TOKEN` is svc-token's test database URL, not a token, and
 * `DATABASE_URL` is not a password. The secret content of a URL is the
 * `user:password@` inside it — which INLINE_URL_CREDENTIAL checks on the same
 * line, and checks better. Excluding them here removes a false positive without
 * removing any coverage.
 */

/**
 * ── KNOWN DISCLOSED ─────────────────────────────────────────────────────────
 *
 * Findings that are REAL, are already disclosed permanently in git history, and
 * whose remedy is an owner rotation rather than a code edit. They are printed
 * on every run and do not fail the build. Anything not listed here fails.
 *
 * Rules for this list, and they are the only thing keeping it honest:
 *
 *   1. An entry is a promise that the finding is in the owner action list at
 *      `docs/SECRET-ROTATION-READINESS-2026-08-03.md`. `action` names the item.
 *   2. An entry that no longer matches a real violation at that file and line
 *      is a FAILURE, not a silent pass. A register you can leave behind is a
 *      register that becomes an exemption list.
 *   3. Nothing goes here to make a build green. The reason field has to say why
 *      an edit is the wrong instrument, and "it was noisy" is not that reason.
 *
 * Why these four are registered rather than edited out: `01_wallet_rpc` cannot
 * be compiled from this tree at all (its `pom.xml` lists an `xrp` module that is
 * not tracked — A1.4 §1), and `ucenter-api` is under the security-review
 * precondition of docs/adr/2026-08-02-adopt-vendored-product-keep-our-ledger.md
 * §62. Editing a withdrawal path I cannot build, or the construction order of a
 * running controller I cannot test, trades a permanent disclosure I cannot undo
 * for a fresh risk I cannot measure. Removing the literal from HEAD does not
 * un-disclose it; only the owner's rotation does.
 */
const KNOWN_DISCLOSED = [
  // 2026-10-19: the six vendored-tree rows (admin console key, captcha pair, geetest key,
  // 2FA demo seed, ACT node credential) left this register because vendor/ was deleted,
  // not because the RISK is gone. The values stay disclosed in git history; their owner
  // rotations remain open in docs/SECRET-ROTATION-READINESS-2026-08-03.md.
  // NOT listed, and the omission is a checked result rather than an oversight:
  // `01_wallet_rpc/usdt/.../JsonrpcClient.java:163` also embeds a credentialled
  // URL in a `main()`, but its password is IDENTICAL to its username and the
  // host is 127.0.0.1 — the matched dev pair this file already argues is not a
  // disclosure. It was in this register on the first draft; the staleness rule
  // above is what caught the mistake.
  // ── OWNER-1, the two ECT withdrawal seeds: REMOVED 2026-08-04, and the way
  // they left is the point of rule 2 above.
  //
  // Both were registered here on this branch: the seed committed as
  // `coin.withdraw-wallet` in the ect module's properties, and a second one
  // hard-coded in an `EctApi` `main()` that signed a real transfer. While this
  // branch was open, #720 removed both from HEAD — the property is now
  // `${ECT_WITHDRAW_WALLET_SECRET}` with a boot refusal on the disclosed value,
  // and the `main()` is deleted. That PR deliberately did not edit this file,
  // because this branch already had it open; its own residual note says so.
  //
  // Nobody had to remember. On the rebase onto that work, the two entries no
  // longer matched a real finding and the scan went RED and named them — which
  // is the whole reason an entry that has stopped being true is a failure
  // rather than a silent pass. Had this list been advisory, it would now be
  // covering two findings that are gone while implying they are still there.
  //
  // What did NOT change: the seeds are still disclosed in git history, so
  // OWNER-1 in docs/SECRET-ROTATION-READINESS-2026-08-03.md stays open. It is
  // an owner rotation, and removing a literal from HEAD has never been able to
  // un-disclose it. The entries left this register because the CODE finding is
  // gone, not because the RISK is.
];

const registerKey = (v) => `${v.file.replace(/\\/g, '/')}:${v.line}:${v.check}`;
/**
 * `SECRET_SCAN_NO_REGISTER=1` empties the register, so every known-disclosed
 * finding becomes a hard failure. `secret-scan.mutation.mjs` sets it because it
 * runs the scan against a synthetic repo where none of the registered files
 * exist, and the staleness rule would otherwise fire on every one of them.
 *
 * An env flag is safe here because it can only make the gate STRICTER. Setting
 * it in CI turns the build red, never green — so it is not a bypass and cannot
 * decay into one.
 */
const REGISTER_DISABLED = process.env.SECRET_SCAN_NO_REGISTER === '1';
const REGISTERED = REGISTER_DISABLED ? [] : KNOWN_DISCLOSED;
const REGISTER = new Map(REGISTERED.map((e) => [registerKey(e), e]));

function tracked() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

function isScanned(rel) {
  const base = rel.split(/[\\/]/).pop();
  if (SCANNED_BASENAMES.has(base)) return true;
  if (base.startsWith('.env')) return true;
  return SCANNED_EXTENSIONS.has(extname(base).toLowerCase());
}

function isScannedSource(rel) {
  const base = rel.split(/[\\/]/).pop();
  return SCANNED_SOURCE_EXTENSIONS.has(extname(base).toLowerCase());
}

function exemptReason(rel) {
  for (const { pattern, reason } of EXEMPT_PATHS) if (pattern.test(rel)) return reason;
  return null;
}

const isPlaceholder = (value) => PLACEHOLDER_VALUES.some((p) => p.test(value.trim()));

/**
 * `key:` as an ATTRIBUTE-NAME field, not as a credential.
 *
 * OpenTelemetry and Kubernetes-style YAML express attributes as `- key: <name>`
 * / `value: <value>` pairs, so the config key is literally `key` and its value
 * is the name of an attribute. `tooling/infra/otel-collector.yaml` has two:
 * `deployment.environment` and `intafaced.money_path`. This scanner does not
 * qualify YAML keys by their parent path, so both arrive here as a bare `key`.
 *
 * Matched on the VALUE rather than by exempting the name, and that distinction
 * is the whole point. Exempting a bare `key` outright would blind the scanner to
 * `tls:\n  key: "-----BEGIN PRIVATE KEY-----…"`, which is a real shape and one
 * this gate has no other way to catch — it is deliberately not a high-entropy
 * scanner (see the header), so nothing else would notice. A dotted lowercase
 * identifier cannot be PEM material, a token or a password, so this exempts the
 * OTel idiom and nothing else.
 */
const ATTRIBUTE_NAME_VALUE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const isAttributeNameField = (key, value) => key === 'key' && ATTRIBUTE_NAME_VALUE.test(value.trim());

/**
 * `key:` as an `actions/cache` KEY, not as a credential.
 *
 * The cache action names its lookup key `key`, so a workflow or composite action under `.github/` that caches
 * anything writes `key: <name>-${{ runner.os }}-${{ hashFiles('<file>') }}` (first needed for the Java toolchain
 * cache, #6860). Matched on the VALUE, like the attribute-name case above, and only under `.github/`: lowercase
 * letter words joined by dashes, then one or more `${{ runner.os }}`, `${{ runner.arch }}` or
 * `${{ hashFiles('<path>', ...) }}` expressions, at least one of them a hashFiles. A digit-bearing or mixed-case
 * literal, a `secrets.`/`inputs.` reference, or PEM material behind a bare `key` is still a finding.
 */
const CACHE_KEY_EXPR = String.raw`\$\{\{\s*(?:runner\.(?:os|arch)|hashFiles\('[A-Za-z0-9_./*-]+'(?:,\s*'[A-Za-z0-9_./*-]+')*\))\s*\}\}`;
const CACHE_KEY_VALUE = new RegExp(String.raw`^[a-z]+(?:-[a-z]+)*(?:-${CACHE_KEY_EXPR})+$`);
const isCacheKeyField = (rel, key, value) =>
  key === 'key' && rel.startsWith('.github/') && CACHE_KEY_VALUE.test(value.trim()) && value.includes('hashFiles(');

/**
 * The repo's dev convention: a credential whose password EQUALS its username —
 * `svc_trade:svc_trade@postgres`, `intafaced:intafaced`. It appears throughout
 * docker-compose, .env.example and the CI workflow.
 *
 * Treated as a self-evident non-secret, and that is a judgement worth stating.
 * A reader who sees `svc_trade:svc_trade` learns nothing they did not already
 * know from the username, so it carries no information an attacker can use. It
 * is not "safe" in the sense of being a good password — it is safe in the sense
 * of not being a *disclosure*. If one of these ever guards something reachable,
 * the finding is the reachability, not the literal, and this scan is the wrong
 * tool for it. Host exposure is checked against `docker ps`; see
 * docs/A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md.
 */
const isMatchedDevPair = (user, password) => user.toLowerCase() === password.toLowerCase();

/**
 * A config value that is a list of relative FILE PATHS under a key literally
 * named `tokens`: `"tokens": ["src/app/globals.css", "../ui/tokens.css"]`.
 *
 * `apps/admin/.21st/design.json` (the 21st design-context file) names its
 * design-token SOURCES under a key called `tokens`. The key reads as a
 * credential; the value is where the design tokens are defined. Three things
 * must ALL hold, so the carve-out cannot hide a credential:
 *   · the key is exactly `tokens` (`"password": ["p@ss/x.k9"]` and
 *     `api_key: ["x/y.abc"]` are still findings);
 *   · every element is a quoted string that contains a `/` AND ends in a file
 *     extension, so a list holding one real secret (`["MUTANT-..."]`,
 *     `["hunter2"]`, a base64 blob) is still a finding;
 *   · no element contains `:` or `@`, so a URL with credentials in it
 *     (`https://user:pw@host/a.json`) is still a finding.
 * A scalar is never matched.
 * @param {string} key the assignment key, unquoted
 * @param {string} rawValue the text after the `:` / `=`, trailing comma allowed
 */
const FILE_PATH_ELEMENT = String.raw`"[^"\s:@]*\/[^"\s:@]*\.[A-Za-z0-9]{1,8}"`;
const FILE_PATH_LIST = new RegExp(String.raw`^\[\s*${FILE_PATH_ELEMENT}(?:\s*,\s*${FILE_PATH_ELEMENT})*\s*\]\s*,?$`);
const isFilePathList = (key, rawValue) => /^tokens$/i.test(key) && FILE_PATH_LIST.test(rawValue.trim());

/**
 * A source constant that holds the NAME of an environment variable, or a URL
 * route, not a credential.
 *
 *   public static final String SECRET_ENV = "INTERNAL_SERVICE_SECRET";   // the env var's name
 *   export const API_KEY_OWNERSHIP_PATH = '/internal/api-keys';           // an HTTP route
 *
 * Both identifiers START with a credential word, so the identifier rule fires.
 * Both are told apart by BOTH halves matching, never by the value alone:
 *   · the identifier ENDS in `_ENV`/`_ENV_NAME`/`_ENV_VAR` and the value is an
 *     UPPER_SNAKE_CASE name made of LETTERS ONLY with at least one underscore
 *     (no digits: `PROD_ADMIN_PW_2026_XK9Q` is a password, not a name); or
 *   · the identifier ENDS in `_PATH`/`_ROUTE`/`_ENDPOINT`/`_URL`/`_URI` and the
 *     value is a route: `/`-rooted segments that are lowercase words (hyphens
 *     allowed), `v1`-style versions, `{param}` or `:param`. Upper-case letters,
 *     digits inside a word, `_`, `.` and `~` are not route segments, so
 *     `/MUTANT-...`, `/services/T0AAAA/B0BBBB/<token>` and `/v1/sk_live_...`
 *     are still findings.
 * `SECRET_ENV = "hunter2xyz"` and `API_KEY_PATH = "Zm9vYmFy"` are still findings.
 * @param {string} normalisedName identifier after camelCase to snake_case
 * @param {string} value
 */
const ENV_NAME_VALUE = /^[A-Z]+(?:_[A-Z]+)+$/;
const ROUTE_VALUE = /^(?:\/(?:[a-z]+(?:-[a-z]+)*|v\d+|\{[A-Za-z]+\}|:[A-Za-z]+))+\/?$/;
const isPointerNotSecret = (normalisedName, value) => {
  const v = value.trim();
  if (/(?:^|_)ENV(?:_NAME|_VAR)?$/i.test(normalisedName) && ENV_NAME_VALUE.test(v)) return true;
  if (/_(?:PATH|ROUTE|ENDPOINT|URL|URI)$/i.test(normalisedName) && ROUTE_VALUE.test(v)) return true;
  return false;
};

const violations = [];
let filesScanned = 0;
let sourceFilesScanned = 0;
let assignmentsChecked = 0;

for (const rel of tracked()) {
  const isConfig = isScanned(rel);
  const isSource = !isConfig && isScannedSource(rel);
  if (!isConfig && !isSource) continue;
  if (exemptReason(rel)) continue;

  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue;

  let content;
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    continue; // unreadable or binary
  }
  if (content.includes('\u0000')) continue;

  if (isConfig) filesScanned++;
  else sourceFilesScanned++;
  const isTest = TEST_FILE.test(rel);
  const inWalletTree = WALLET_SIGNING_TREE.test(rel);
  // Shell is source by extension but config by shape — `export KEY=value` is an
  // assignment, not a declaration, so it gets the config rule as well.
  const isShell = /\.(?:sh|bash)$/i.test(rel);
  const lines = content.split(/\r?\n/);

  /**
   * Usernames declared anywhere in this file. Used to recognise the matched
   * dev pair when it is written as two adjacent keys rather than inside a URL:
   *
   *     POSTGRES_USER: intafaced
   *     POSTGRES_PASSWORD: intafaced
   *
   * Same judgement as isMatchedDevPair — a password identical to the username
   * sitting beside it discloses nothing.
   */
  const declaredUsernames = new Set(
    lines
      .map((l) => /^[-\s]*["']?([A-Za-z0-9_.\-[\]]*(?:user|username|user_name))["']?\s*[:=]\s*(.+?)\s*$/i.exec(l.trim()))
      .filter(Boolean)
      .map((m) => m[2].replace(/^['"]|['"]$/g, '').toLowerCase()),
  );

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const trimmed = line.trim();
    // Comments, in every syntax this now reads. `/*` joined the list when source
    // scanning landed: without it this file's own doc comment describing the
    // `scheme://user:password@host` shape was reported as a finding, which is a
    // small joke and a real bug — a scanner that cannot read a comment cannot
    // read most of a Java file.
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

    // ── credential-shaped key = literal value ────────────────────────────────
    // Handles `key=value`, `key: value` and `- key: value`.
    // CONFIG FILES AND SHELL. Running this over Java/TS is the noise catastrophe
    // the header describes; those get the three narrow checks further down.
    //
    // The leading-keyword strip is what makes `ENV API_KEY=…` in a Dockerfile
    // and `export API_KEY=…` in a deploy script visible: both are `key=value`
    // wearing a prefix, and the mutation test scored them as survivors until
    // this line existed. Measured cost across the repo: zero new hits — the
    // only ENV/export lines here set PATH, NODE_ENV and a port.
    const declLine = isConfig || isShell ? trimmed.replace(/^(?:ENV|ARG|export|declare\s+-x|set\s+-x)\s+/i, '') : null;
    const assignment = declLine === null ? null : /^[-\s]*["']?([A-Za-z0-9_.\-[\]]+)["']?\s*[:=]\s*(.*)$/.exec(declLine);
    if (assignment) {
      const [, key, rawValue] = assignment;
      const value = rawValue.replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '');

      // ── keys that carry key material despite a harmless name ──────────────
      for (const conv of SECRET_BY_CONVENTION) {
        if (!conv.key.test(key)) continue;
        assignmentsChecked++;
        if (isPlaceholder(value) || conv.allow.test(value.trim())) continue;
        violations.push({
          check: 'secret-by-convention',
          file: rel,
          line: lineNo,
          key,
          reason: `\`${key}\` is assigned a literal value, and ${conv.reason}`,
          detail:
            'Move it to the environment with NO default — `${VAR}` — so the service refuses to start rather than signing with a published seed.',
        });
      }

      if (
        SECRET_KEY.test(key) &&
        !NOT_ACTUALLY_SECRET.some((p) => p.test(key)) &&
        !isAttributeNameField(key, value) &&
        !isCacheKeyField(rel, key, value)
      ) {
        assignmentsChecked++;
        if (declaredUsernames.has(value.toLowerCase()) && value.trim() !== '') {
          // password === a username declared in this same file: the dev convention.
        } else if (!isPlaceholder(value) && !isFilePathList(key, rawValue)) {
          violations.push({
            check: 'committed-credential',
            file: rel,
            line: lineNo,
            key,
            reason: `\`${key}\` is assigned a literal value`,
            detail:
              'Move it to the environment with NO default — `${VAR}` — so the service refuses to start rather than booting on a stale credential.',
          });
        } else if (/^\$\{[^}]+:-(.+)\}$/.test(value)) {
          const fallback = /^\$\{[^}]+:-(.+)\}$/.exec(value)[1];
          if (!isPlaceholder(fallback)) {
            violations.push({
              check: 'credential-default',
              file: rel,
              line: lineNo,
              key,
              reason: `\`${key}\` falls back to a non-placeholder default`,
              detail: 'A default on a credential means the service boots insecurely instead of failing loudly. Drop the `:-fallback`.',
            });
          }
        }
      }
    }

    // ── inline user:password@host in any URL ─────────────────────────────────
    INLINE_URL_CREDENTIAL.lastIndex = 0;
    let m;
    while ((m = INLINE_URL_CREDENTIAL.exec(trimmed)) !== null) {
      const [, user, password] = m;
      if (isPlaceholder(password) || password.includes('${')) continue;
      if (isMatchedDevPair(user, password)) continue;
      assignmentsChecked++;
      violations.push({
        check: 'inline-url-credential',
        file: rel,
        line: lineNo,
        key: '(URL)',
        reason: 'a URL on this line embeds `user:password@host`',
        detail:
          'Put the whole URL in the environment with no default. A credential hidden inside a connection string is still a committed credential.',
      });
    }

    if (!isSource) return;

    // ── source: credential-named identifier = string literal ─────────────────
    // Not in test files — see TEST_FILE for why that is a coverage decision and
    // not a concession.
    if (!isTest) {
      SOURCE_DECLARATION.lastIndex = 0;
      let d;
      while ((d = SOURCE_DECLARATION.exec(line)) !== null) {
        const [, name, , value] = d;
        // camelCase → snake, so the same ends-with rule reads `secretKey` and
        // `secret_key` identically.
        const normalised = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
        if (!SECRET_IDENTIFIER.test(normalised) && !SECRET_IDENTIFIER.test(name)) continue;
        if (value.trim().length < MIN_SOURCE_LITERAL_LENGTH) continue;
        if (isPlaceholder(value)) continue;
        if (isPointerNotSecret(normalised, value)) continue;
        assignmentsChecked++;
        violations.push({
          check: 'source-credential-literal',
          file: rel,
          line: lineNo,
          key: name,
          reason: `\`${name}\` is declared equal to a string literal`,
          detail:
            'A credential in source is a credential in every build artefact that ever shipped. Inject it — @Value/${VAR}/env — with no default, so an unset value stops the service instead of shipping the published one.',
        });
      }
    }

    // ── source: string literal handed to a value-moving call ─────────────────
    if (inWalletTree) {
      WALLET_SIGNING_LITERAL.lastIndex = 0;
      let w;
      while ((w = WALLET_SIGNING_LITERAL.exec(line)) !== null) {
        const value = w[2];
        if (isPlaceholder(value)) continue;
        assignmentsChecked++;
        violations.push({
          check: 'wallet-signing-literal',
          file: rel,
          line: lineNo,
          key: '(positional argument)',
          reason: 'a string literal is passed into a call that moves value',
          detail:
            'A signing call handed a constant is a signing key in the repository, whatever the argument is named. Take it from args or the environment, or delete the harness.',
        });
      }
    }
  });
}

// ── register reconciliation ─────────────────────────────────────────────────
// Split the findings into "already disclosed, owner rotates" and "new".
const disclosed = [];
const unregistered = [];
const seenRegisterKeys = new Set();

for (const v of violations) {
  const k = registerKey(v);
  const entry = REGISTER.get(k);
  if (entry) {
    seenRegisterKeys.add(k);
    disclosed.push({ ...v, entry });
  } else {
    unregistered.push(v);
  }
}

// Rule 2: an entry that no longer describes a real finding is itself a failure.
const staleRegisterEntries = REGISTERED.filter((e) => !seenRegisterKeys.has(registerKey(e)));

const ROTATION_DOC = 'docs/SECRET-ROTATION-READINESS-2026-08-03.md';

// Printed on EVERY run, green or red. A disclosure the owner has not yet
// rotated should be as visible on the thousandth build as on the first.
if (disclosed.length > 0) {
  console.log(`\n⚠ KNOWN DISCLOSED — ${disclosed.length} finding(s) awaiting owner rotation, not failing the build`);
  console.log(`  Owner action list: ${ROTATION_DOC}\n`);
  for (const v of disclosed) {
    console.log(`  [${v.check}] ${v.file}:${v.line}  → ${v.entry.action}`);
  }
  console.log('');
}

if (staleRegisterEntries.length > 0) {
  console.error(`\n✖ SECRET SCAN FAILED — ${staleRegisterEntries.length} stale KNOWN_DISCLOSED entr(ies)\n`);
  for (const e of staleRegisterEntries) {
    console.error(`  [${e.check}] ${e.file}:${e.line}`);
    console.error(`    → registered as ${e.action}, but no such finding exists there any more\n`);
  }
  console.error('  Either the finding was fixed — in which case delete the entry and say so in');
  console.error(`  ${ROTATION_DOC} — or the code moved and the`);
  console.error('  register is now pointing at the wrong line, which is worse than not having one.\n');
  process.exit(1);
}

if (unregistered.length > 0) {
  console.error(`\n✖ SECRET SCAN FAILED — ${unregistered.length} credential-shaped literal(s) in tracked files\n`);
  for (const v of unregistered) {
    // Deliberately prints the KEY and LOCATION, never the value. A CI log is
    // not a place to reproduce the secret you are complaining about.
    console.error(`  [${v.check}] ${v.file}:${v.line}`);
    console.error(`    → ${v.reason}`);
    console.error(`      ${v.detail}\n`);
  }
  console.error('  A committed credential is invisible in review and permanent in history.');
  console.error(
    '  If a value here is genuinely not a secret, make it say so (see PLACEHOLDER_VALUES\n  in tooling/ci/secret-scan.mjs) rather than widening the rule.\n',
  );
  console.error('  If it IS a secret and the fix is an owner rotation rather than an edit, it goes');
  console.error(`  in KNOWN_DISCLOSED with an action id from ${ROTATION_DOC} —\n  never in EXEMPT_PATHS.\n`);
  process.exit(1);
}

console.log(
  `✓ secret-scan clean — ${assignmentsChecked} credential-shaped assignment(s) across ` +
    `${filesScanned} tracked config file(s) and ${sourceFilesScanned} source file(s)` +
    (disclosed.length > 0 ? `, ${disclosed.length} known-disclosed awaiting rotation` : ''),
);
