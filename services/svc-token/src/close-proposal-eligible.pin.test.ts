import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('token.closeProposal eligible is ledger-backed', () => {
  it('refuses table/ledger drift and reads the quorum bar from the ballot snapshot', () => {
    const service = readFileSync(join(here, 'token-service.ts'), 'utf8');
    const closeProposal = service.slice(service.indexOf('async closeProposal('), service.indexOf('Fold grouped vote rows'));
    expect(closeProposal).toMatch(/tokenStakeAccount\(/);
    expect(closeProposal).toMatch(/this\.ledger\.balance/);
    expect(closeProposal).toMatch(/token\.stake_ledger_mismatch/);
    expect(closeProposal).toMatch(/SELECT id, user_id, amount/);
    expect(closeProposal).toMatch(/eligible_stake/);
    expect(closeProposal).not.toMatch(/eligibleStake \+=/);
    expect(closeProposal).not.toMatch(/COALESCE\(SUM\(amount\)/);
  });
});
