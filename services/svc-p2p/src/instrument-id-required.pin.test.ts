import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('instruments.create requires a caller instrumentId', () => {
  it('does not mint a UUID on add', () => {
    const service = readFileSync(join(here, 'instrument-service.ts'), 'utf8');
    const create = service.slice(service.indexOf('async createInstrument'), service.indexOf('async updateInstrument'));
    expect(create).toMatch(/p2p\.instrument_id_required/);
    expect(create).not.toMatch(/crypto\.randomUUID\(\)/);
  });

  it('router create input requires instrumentId uuid', () => {
    const router = readFileSync(join(here, 'router.ts'), 'utf8');
    const instruments = router.slice(router.indexOf('instruments: router({'));
    const create = instruments.slice(
      instruments.indexOf('create: merchantApiProcedure'),
      instruments.indexOf('update: merchantApiProcedure'),
    );
    expect(create).toMatch(/instrumentId: z\.string\(\)\.guid\(\)/);
    expect(create).toMatch(/instrumentId: input\.instrumentId/);
  });
});
