import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The allowlist only protects money if the claim and the direct door both ask it. Pin the wiring in `index.ts`. */
const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.ts'), 'utf8');

describe('allowlist wiring in the service entry', () => {
  it('rides the withdrawal claim, before the approval gate', () => {
    expect(index).toMatch(/claimGuards:\s*composeGuards\(createAllowlistGuards\(\),\s*createWithdrawalApprovalGuards\(\)\)/);
  });

  it('is asked by the direct withdrawal door before the approvals', () => {
    expect(index).toMatch(/await allowlist\.assertDirectAllowed\(input\);\s*await withdrawalApprovals\.assertDirectAllowed\(input\);/);
    expect(index).toMatch(/withdrawalQuotes, withdrawalDoor, merchantTerms\)/);
  });

  it('mounts the customer and founder routers', () => {
    expect(index).toContain('createAllowlistRouter(allowlist)');
    expect(index).toContain('allowlist: { service: allowlist }');
  });
});
