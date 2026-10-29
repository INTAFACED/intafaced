import { describe, expect, it } from 'vitest';
import { agentBuilderCopy } from './agent-builder-copy';

const PAGES = [
  'Rules',
  'Permissions',
  'Memory',
  'Privacy',
  'Access',
  'Allowance',
  'Schedules',
  'Triggers',
  'Runs',
  'Analytics',
  'Evaluations',
] as const;
const LABELS = {
  en: ['Rules', 'Permissions', 'Memory', 'Privacy', 'Access', 'Allowance', 'Schedules', 'Triggers', 'Runs', 'Analytics', 'Evaluations'],
  es: [
    'Reglas',
    'Permisos',
    'Memoria',
    'Privacidad',
    'Acceso',
    'Asignación',
    'Horarios',
    'Disparadores',
    'Ejecuciones',
    'Analítica',
    'Evaluaciones',
  ],
  fr: [
    'Règles',
    'Autorisations',
    'Mémoire',
    'Confidentialité',
    'Accès',
    'Allocation',
    'Planifications',
    'Déclencheurs',
    'Exécutions',
    'Analyses',
    'Évaluations',
  ],
} as const;

describe('agent builder tab labels', () => {
  it.each(Object.keys(LABELS) as (keyof typeof LABELS)[])(
    '%s shows its own tab labels, never another locale’s or a blocker sentence',
    (locale) => {
      const copy = agentBuilderCopy.forLocale(locale);
      expect(PAGES.map((page) => copy.t(`page_${page}`))).toEqual(LABELS[locale]);
      expect(PAGES.map((page) => copy.languageFor(`page_${page}`))).toEqual(PAGES.map(() => locale));
    },
  );
});

describe('a blank rate', () => {
  it.each(['en', 'es', 'fr'] as const)('%s names the rate the refused run is billed at and that nothing runs free', (locale) => {
    const words = agentBuilderCopy.forLocale(locale).t('code_price_unset');
    expect(words).toContain('own.run');
    expect(words).toMatch({ en: /Nothing runs free/, es: /Nada se ejecuta gratis/, fr: /Rien ne tourne gratuitement/ }[locale]);
  });
});
