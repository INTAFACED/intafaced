#!/usr/bin/env node
/**
 * Vendor shell residue scan — keep the Java exchange UI from re-introducing
 * known money/CORS hazards that the TS ledger does not own.
 *
 * Residual queue (docs/POST-MERGE-RESIDUAL-AFTER-86.md (removed) + PEACE cleanup):
 *   - mass balance credit symbols (unfreezeMore / unfreezeLess bulk SQL)
 *   - TRUNCATE wallet snapshot helpers (dropWeekTable class)
 *   - CORS wildcard origin with credentials
 *   - dual-book mint paths still present as dead residue elsewhere
 *
 * Brand scan deliberately skips vendor/** (upstream identity lives there).
 * This scan is the complementary check: hazards inside vendor/** only.
 *
 * Exit 0 = clean. Exit 1 = a known residual hazard is present.
 *
 * Allowlist: keep empty unless a deliberate, reviewable exception is needed.
 * Every entry must carry a path + reason (same shape as brand-scan ALLOWLIST).
 * Prefer deleting the hazard over allowlisting it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
// Path under repo `vendor/` only — brand-scan forbids naming the upstream tree
// in source; keep this path as path segments, not a banned token string.
const VENDOR = join(ROOT, 'vendor');

/**
 * Paths exempt from the scan. Deliberately empty: residual money mutators
 * have no legitimate home under vendor/**. If a future exception is required,
 * add `{ path: 'vendor/...', reason: '...' }` here and justify in the PR.
 *
 * @type {{ path: string, reason: string }[]}
 */
const ALLOWLIST = [];

/** @type {{ id: string, re: RegExp, reason: string }[]} */
const FORBIDDEN = [
  // ── Symbol bans: deleted PEACE residuals must not reappear ──────────────
  {
    id: 'symbol-unfreezeMore',
    re: /\bunfreezeMore\b/,
    reason: 'deleted PEACE residual — mass +500 balance credit; do not reintroduce',
  },
  {
    id: 'symbol-dropWeekTable',
    re: /\bdropWeekTable\b/,
    reason: 'deleted PEACE residual — TRUNCATE of wallet snapshot tables; do not reintroduce',
  },
  // ── SQL / body patterns (still live in other residual forms) ────────────
  {
    id: 'mass-credit-plus-500',
    re: /balance\s*=\s*balance\s*\+\s*500/i,
    reason: 'mass +500 balance credit (unfreezeMore class) — shell is not the books',
  },
  {
    id: 'mass-credit-to-released',
    re: /balance\s*=\s*balance\s*\+\s*to_released/i,
    reason: 'mass credit of to_released into balance (unfreezeLess class)',
  },
  {
    id: 'truncate-wallet-snapshot',
    re: /TRUNCATE\s+TABLE\s+member_wallet_/i,
    reason: 'TRUNCATE of wallet snapshot tables (dropWeekTable class)',
  },
  {
    id: 'cors-star-origin',
    // Active code only — Javadoc {@code ...} may still name the anti-pattern.
    re: /addAllowedOrigin\s*\(\s*"\*"\s*\)/,
    reason: 'CORS wildcard origin (must use CorsAllowlist / explicit origins)',
  },
  {
    id: 'jdbc-mass-to-released',
    re: /to_released\s*=\s*to_released\s*-\s*/,
    reason: 'bulk to_released debit via string SQL (JDBCUtils class)',
  },
  {
    id: 'minings-job-credit',
    // Live body only — disabled job throws before this path.
    re: /userWallet\.setBalance\s*\(\s*userWallet\.getBalance\s*\(\s*\)\s*\.add\s*\(/,
    reason: 'MiningsJob-class shell balance mint (dual-book; shell is not the books)',
  },
  {
    id: 'dao-increase-balance-for-bhb-live',
    // Only the live mint form (not no-op WHERE 1=0 replacements).
    re: /SET\s+balance\s*=\s*balance\s*\+\s*:balance\s+WHERE\s+coin_id\s*=\s*'BHB'/i,
    reason: 'DAO increaseBalanceForBHB live mint SQL (must stay no-op)',
  },
  // ── Dual-book four mutators (Plan P2-2 · Spec DB-3) — live JPQL only ────
  {
    id: 'jpql-wallet-balance-plus',
    re: /wallet\.balance\s*=\s*wallet\.balance\s*\+\s*:amount/i,
    reason: 'live increaseBalance/thaw JPQL — dual-book (must be no-op WHERE 1=0)',
  },
  {
    id: 'jpql-wallet-frozen-plus',
    re: /wallet\.frozenBalance\s*=\s*wallet\.frozenBalance\s*\+\s*:amount/i,
    reason: 'live freezeBalance JPQL — dual-book (must be no-op WHERE 1=0)',
  },
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'target' || name === '.git') continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    // Java primary; shell/config secondary so a cron or XML job cannot sneak back.
    else if (/\.(java|js|ts|xml|yml|yaml|properties|sh)$/i.test(name)) out.push(p);
  }
  return out;
}

function isAllowlisted(relPath) {
  return ALLOWLIST.some((entry) => relPath === entry.path || relPath.startsWith(entry.path + sep));
}

if (!statSync(VENDOR, { throwIfNoEntry: false })?.isDirectory()) {
  console.log('✓ vendor-shell-scan: no vendor/ tree — skip');
  process.exit(0);
}

const files = walk(VENDOR);
const hits = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  if (isAllowlisted(rel)) continue;

  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // Skip pure comments / javadoc lines that document the ban.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.includes('{@code addAllowedOrigin')) {
      continue;
    }
    for (const rule of FORBIDDEN) {
      if (rule.re.test(line)) {
        hits.push({ rel, line: i + 1, id: rule.id, reason: rule.reason, text: trimmed.slice(0, 160) });
      }
    }
  }
}

if (hits.length) {
  console.error('✖ vendor-shell-scan failed — known residual hazards present:\n');
  for (const h of hits) {
    console.error(`  ${h.rel}:${h.line}  [${h.id}] ${h.reason}`);
    console.error(`    ${h.text}`);
  }
  console.error(`\n${hits.length} hit(s) in ${files.length} file(s). Shell UI must not mass-credit, TRUNCATE wallets, or open CORS "*".`);
  console.error('  Allowlist (prefer delete): ALLOWLIST in tooling/ci/vendor-shell-scan.mjs\n');
  process.exit(1);
}

console.log(`✓ vendor-shell-scan clean — ${files.length} vendor file(s), ${FORBIDDEN.length} hazard pattern(s)`);
