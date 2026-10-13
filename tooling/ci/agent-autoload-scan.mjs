#!/usr/bin/env node
/**
 * AGENT AUTOLOAD SCAN
 *
 * Ensures cold agents still see money/chain locks and full-access ship law.
 *
 * Run: node tooling/ci/agent-autoload-scan.mjs
 * Wired: pnpm scan:agent-autoload · CI doctrine gates · pnpm verify
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const problems = [];

function read(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    problems.push(`missing required auto-load file: ${rel}`);
    return '';
  }
  return readFileSync(p, 'utf8');
}

function mustInclude(rel, needle, why) {
  const body = read(rel);
  if (!body) return;
  if (!body.toLowerCase().includes(String(needle).toLowerCase())) {
    problems.push(`${rel}: missing ${JSON.stringify(needle)} — ${why}`);
  }
}

mustInclude('AGENTS.md', 'Full access', 'cold agents must inherit full-access ship law');
mustInclude('AGENTS.md', 'Merge when done', 'must not regress to CI or human merge gates');
mustInclude('AGENTS.md', 'Do not wait for CI green', 'CI must stay informational not a ship gate');
mustInclude('AGENTS.md', '403 or 429', 'cold agents must stop on GitHub refusals instead of retrying or changing credentials');
mustInclude('AGENTS.md', 'ledger-client', 'value must stay in the ledger');
mustInclude('AGENTS.md', 'number', 'money must not be a JS number');
mustInclude('AGENTS.md', 'INTERNET-LEVERAGE-LAW', 'do not rebuild kit / second book');
mustInclude('AGENTS.md', 'Internet leverage law', 'section name the scan already keys on');
mustInclude('AGENTS.md', 'pnpm wt', 'worktree law');
mustInclude('AGENTS.md', 'COORDINATION-TRUTH-LAYERS', 'tracker is a map, not a permission system');

mustInclude('CLAUDE.md', 'AGENTS.md', 'Claude must chain into the one set of rules');

mustInclude('tooling/agent-protocol/AGENT_PROTOCOL.md', 'COORDINATION-TRUTH-LAYERS', 'protocol hard path must name the layers home');
mustInclude('tooling/agent-protocol/AGENT_PROTOCOL.md', 'Full access', 'agents must not regress to human permission gates');
mustInclude('tooling/agent-protocol/AGENT_PROTOCOL.md', 'INTERNET-LEVERAGE-LAW', 'protocol still names leverage');
mustInclude('tooling/agent-protocol/AGENT_PROTOCOL.md', 'second money book', 'no second book');

mustInclude('docs/COORDINATION-TRUTH-LAYERS.md', 'No PR cap', 'anti-limit guarantees must stay in the law home');
mustInclude('docs/COORDINATION-TRUTH-LAYERS.md', 'mountain events', 'mountain-events-only rule must stay');

mustInclude('docs/INTERNET-LEVERAGE-LAW.md', 'Phase A is finished for NOW', 'operator decision stays');
mustInclude('docs/INTERNET-LEVERAGE-LAW.md', 'Mandatory pre-code ritual', 'agents need an executable ritual not a vague blog');

for (const rel of ['AGENTS.md', 'docs/COORDINATION-TRUTH-LAYERS.md']) {
  const body = read(rel);
  if (!body) continue;
  for (const line of body.match(/^.*(?:~\/projects\/|OS harvest|\/Users\/[A-Za-z0-9._-]+\/projects\/).*$/gm) || []) {
    if (/agent-auth|\.tools\/bin|token/i.test(line)) continue;
    problems.push(
      `${rel}: cites law outside the repo — "${line.trim().slice(0, 80)}". Move it in-repo; teammates cannot read one machine's disk.`,
    );
  }
}

if (problems.length) {
  console.error('\n✖ agent-autoload-scan failed:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nFix the named files. Do not remove money/chain/leverage/full-access from AGENTS.md/CLAUDE.md.\n');
  process.exit(1);
}

console.log('✓ agent-autoload-scan: full-access + money/chain/leverage intact');
process.exit(0);
