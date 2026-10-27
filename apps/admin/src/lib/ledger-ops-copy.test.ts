import { describe, expect, it } from 'vitest';
import { LEDGER_COPY } from './ledger-ops-copy';
describe('Ledger local language family', () => {
  for (const locale of ['en', 'es', 'fr'] as const)
    it(`${locale} has complete nonempty copy and unavailable/recovery semantics`, () => {
      expect(Object.keys(LEDGER_COPY[locale]).sort()).toEqual(Object.keys(LEDGER_COPY.en).sort());
      for (const value of Object.values(LEDGER_COPY[locale])) expect(value.trim().length).toBeGreaterThan(0);
      expect(LEDGER_COPY[locale].versionMissing).not.toBe(LEDGER_COPY[locale].configured);
      expect(LEDGER_COPY[locale].intro).not.toMatch(/not available|no está disponible|n’est pas disponible/);
      expect(LEDGER_COPY[locale].historyMissing).not.toBe(LEDGER_COPY[locale].recordOnly);
    });
});
