/**
 * Unit card — live boot injects PostgresBroadcastStore
 *
 * 1. Promise: two pay replicas cannot both broadcast the same payout key.
 * 2. Break: defaultChainFor(process.env) with no store → MemoryBroadcastStore
 *    in staging/prod, so two processes each `mine` and sign a second spend.
 * 3. Done bar: index.ts constructs PostgresBroadcastStore(sql) and passes it
 *    to defaultChainFor. staging/prod live chain refuses to build without one.
 * 4. Class M
 * 5. Paths: services/svc-pay/src/index.ts (boot only)
 * 6. RED: pin fails if PostgresBroadcastStore is not the boot journal
 * 7. Collision: none — this pin only reads index.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, 'index.ts'), 'utf8');

describe('boot wires PostgresBroadcastStore', () => {
  it('constructs the durable journal and injects it into defaultChainFor', () => {
    expect(indexSrc).toMatch(/import \{ PostgresBroadcastStore \} from '\.\/rails\/broadcast-store\.js'/);
    expect(indexSrc).toMatch(/import \{ PostgresDepositAddressBook \} from '\.\/rails\/deposit-address-book\.js'/);
    expect(indexSrc).toMatch(/const broadcasts = new PostgresBroadcastStore\(sql\)/);
    expect(indexSrc).toMatch(/const depositAddresses = new PostgresDepositAddressBook\(sql\)/);
    expect(indexSrc).toMatch(/defaultChainFor\(process\.env, broadcasts, depositAddresses\)/);
  });

  it('does not fall back to MemoryBroadcastStore at boot', () => {
    expect(indexSrc).not.toMatch(/new MemoryBroadcastStore\s*\(/);
    expect(indexSrc).not.toMatch(/new MemoryDepositAddressBook\s*\(/);
    expect(indexSrc).not.toMatch(/defaultChainFor\(process\.env\)\s*;/);
  });
});
