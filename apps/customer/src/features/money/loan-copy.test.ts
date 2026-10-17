import { describe, expect, it } from 'vitest';
import { savePreferences } from '../../shared/preferences';
import { loanCopy, loanStatusLabel } from './loan-copy';

const statuses = ['pending', 'active', 'margin_call', 'liquidating', 'repaid', 'liquidated'] as const;
const labels = {
  en: ['Pending', 'Active', 'Margin call', 'Liquidation in progress', 'Repaid', 'Liquidated'],
  es: ['Pendiente', 'Activo', 'Llamada de margen', 'Liquidación en curso', 'Pagado', 'Liquidado'],
  fr: ['En attente', 'Actif', 'Appel de marge', 'Liquidation en cours', 'Remboursé', 'Liquidé'],
} as const;
const unavailable = { en: 'Status unavailable', es: 'Estado no disponible', fr: 'Statut indisponible' } as const;

describe('customer loan status labels', () => {
  for (const locale of ['en', 'es', 'fr'] as const) {
    it(`labels all six service statuses in ${locale}`, () => {
      const copy = loanCopy.forLocale(locale);
      expect(statuses.map((status) => loanStatusLabel(status, copy))).toEqual(labels[locale]);
    });
    it(`hides unknown and inherited-property codes in ${locale}`, () => {
      const copy = loanCopy.forLocale(locale);
      for (const status of ['', 'future_internal_code', 'ACTIVE', ' active ', 'constructor', 'toString', '__proto__', '<script>']) {
        expect(loanStatusLabel(status, copy)).toBe(unavailable[locale]);
      }
    });
  }
  it('uses the current customer language by default', () => {
    try {
      savePreferences({ language: 'fr' });
      expect(loanStatusLabel('margin_call')).toBe('Appel de marge');
      savePreferences({ language: 'es' });
      expect(loanStatusLabel('liquidating')).toBe('Liquidación en curso');
    } finally {
      savePreferences({ language: 'en' });
    }
  });
});
