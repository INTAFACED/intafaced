import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { P2P_INSTRUMENTS_CREATE } from '@intafaced/contracts/p2p-procedures';

const here = dirname(fileURLToPath(import.meta.url));

describe('instruments.create requires a caller instrumentId', () => {
  it('does not mint a UUID on add', () => {
    const service = readFileSync(join(here, 'instrument-service.ts'), 'utf8');
    const create = service.slice(service.indexOf('async createInstrument'), service.indexOf('async updateInstrument'));
    expect(create).toMatch(/p2p\.instrument_id_required/);
    expect(create).not.toMatch(/crypto\.randomUUID\(\)/);
  });

  it('the create record refuses a missing or non-UUID instrumentId (the mounted door: router.mount.test.ts)', () => {
    const add = { methodId: 'sepa', country: 'DE', fiatCurrency: 'EUR', details: { iban: 'DE00' } };
    expect(P2P_INSTRUMENTS_CREATE.input.safeParse(add).success).toBe(false);
    expect(P2P_INSTRUMENTS_CREATE.input.safeParse({ ...add, instrumentId: 'not-a-uuid' }).success).toBe(false);
    expect(P2P_INSTRUMENTS_CREATE.input.safeParse({ ...add, instrumentId: '66666666-6666-4666-8666-666666666666' }).success).toBe(true);
  });
});
