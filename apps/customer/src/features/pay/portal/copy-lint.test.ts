import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chromeMessages } from './chrome/copy';
import { portalMessages } from './copy';
import { extensionMessages } from './extension-copy';
import { layoutMessages } from './home-layout/copy';
import { moneyMessages } from './money/copy';
import { paymentsMessages } from './payments/copy';
import { settingsMessages } from './settings/copy';
import { accountMessages } from './settings/account/copy';
import { applicationMessages } from './settings/onboarding/application-copy';
import { categoryMessages } from './settings/onboarding/category-copy';
import { requestsMessages } from './settings/onboarding/requests-copy';
import { analyticsMessages } from './settings/analytics/copy';
import { developersMessages } from './settings/developers/copy';
import { stepUpMessages } from './access/step-up-copy';
import { reportsMessages } from './settings/reports/copy';
import { uiMessages } from './ui/copy';
import { w3cMessages } from './w3c-copy';
import { catalogMessages } from './catalog/copy';
import { lookMessages } from './payments/look-copy';
import { methodsMessages } from './payments/methods-copy';

/**
 * The portal's catalogues, so the check below covers a package's own copy file the day it is listed. The word rules for
 * these catalogues are the lint rule `garden/pay-portal-copy` (tooling/lint/oxlint-plugin-garden/copy-rules.js).
 */
const catalogs: Record<string, Record<string, string>> = {
  'pay.portal': portalMessages,
  'pay.portal.w3c': w3cMessages,
  'pay.portal.w3c2': extensionMessages,
  'pay.portal.layouts': layoutMessages,
  'pay.portal.chrome': chromeMessages,
  'pay.portal.stepup': stepUpMessages,
  'pay.portal.ui': uiMessages,
  'pay.portal.money': moneyMessages,
  'pay.portal.payments': paymentsMessages,
  'pay.portal.settings': settingsMessages,
  'pay.portal.settings.account': accountMessages,
  'pay.portal.settings.application': applicationMessages,
  'pay.portal.settings.category': categoryMessages,
  'pay.portal.settings.requests': requestsMessages,
  'pay.portal.settings.analytics': analyticsMessages,
  'pay.portal.settings.developers': developersMessages,
  'pay.portal.settings.reports': reportsMessages,
  'pay.portal.catalog': catalogMessages,
  'pay.portal.checkoutLook': lookMessages,
  'pay.portal.checkoutMethods': methodsMessages,
};

const entries = Object.entries(catalogs).flatMap(([namespace, messages]) =>
  Object.entries(messages).map(([key, text]) => [`${namespace}.${key}`, text] as const),
);

describe('merchant portal copy', () => {
  it('reads every portal namespace', () => {
    expect(Object.keys(catalogs).length).toBeGreaterThanOrEqual(9);
    expect(entries.length).toBeGreaterThan(900);
  });
});

describe('unused portal copy', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sources(full);
      return /\.(ts|tsx)$/.test(name) && !/copy\.ts$|copy-lint\.test|copy-ownership\.test/.test(name) ? [full] : [];
    });
  const text = sources(root)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  // Keys built from a prefix or suffix (`block_${reason}`, `${status}Tip`) count as used by anything that starts or ends that way.
  const prefixes = [...text.matchAll(/`([A-Za-z0-9_]+)\$\{/g)].map((m) => m[1]!);
  const suffixes = [...text.matchAll(/\$\{[^}]*\}([A-Za-z0-9_]+)`/g)].map((m) => m[1]!);
  const used = (key: string) =>
    new RegExp(`['"\`]${key}['"\`]`).test(text) ||
    prefixes.some((prefix) => key.startsWith(prefix)) ||
    suffixes.some((suffix) => key.endsWith(suffix));
  // Reads every portal source file, which takes longer than the default on a shared CI runner.
  it('has no key that nothing refers to', () => {
    const dead = entries.map(([id]) => id).filter((id) => !used(id.split('.').slice(-1)[0]!));
    expect(dead).toEqual([]);
  }, 60_000);
});
