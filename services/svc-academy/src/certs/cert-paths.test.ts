/**
 * AC-certificates-01: Academy lists every learning path with its published certificate, and the typed refusal for a path
 * with no published certificate design, so the Certificates tab can show each path without probing them one by one.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { AcademyService } from '../academy-service.js';
import { NullStreamProvider } from '../stream/provider.js';

const sqlNever = (() => {
  throw new Error('certPaths reads no table');
}) as unknown as Sql;

describe('certPaths', () => {
  it('names foundations-v1 for foundations and refuses every path with no published design', () => {
    const academy = new AcademyService(
      sqlNever,
      { stakeOf: async () => 0n },
      {
        async perksOf() {
          throw new Error('host rights unused');
        },
      },
      new NullStreamProvider(),
      {},
    );
    expect(academy.certPaths()).toEqual([
      { path: 'foundations', certId: 'foundations-v1', refusal: null },
      { path: 'markets', certId: null, refusal: 'academy.certificate_unpublished' },
      { path: 'builder', certId: null, refusal: 'academy.certificate_unpublished' },
      { path: 'sovereign', certId: null, refusal: 'academy.certificate_unpublished' },
    ]);
  });
});
