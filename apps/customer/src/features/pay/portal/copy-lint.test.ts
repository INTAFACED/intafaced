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

/**
 * Every visible word in the merchant portal is plain business English: what happened, why, what to do next. This
 * reads every `pay.portal*` namespace, so a package's own copy file is covered the day it is written.
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
};

const banned: Array<[name: string, pattern: RegExp]> = [
  ['a work-package code', /\bW\d+[a-z]?\d?\b/],
  ['"backend"', /\bback-?end\b/i],
  ['"stub"', /\bstubs?\b/i],
  ['"cursor"', /\bcursors?\b/i],
  ['"server"', /\bservers?\b/i],
  ['"contract"', /\bcontracts?\b/i],
  ['"loaded"', /\bloaded\b/i],
  ['"procedure"', /\bprocedures?\b/i],
  ['"projection"', /\bprojections?\b/i],
  ['"fixture"', /\bfixtures?\b/i],
  ['"arrives"', /\barrives?\b/i],
  ['"coming soon"', /\bcoming soon\b/i],
  [
    'a promise of later ("not connected yet", "available yet", "on the way", "soon"): say what is true now and what blocks it',
    /\b(not connected yet|available yet|on the way|coming soon|soon)\b/i,
  ],
  ['a promise of what the person will be able to do, or a request to come back', /you(?:’|')ll be able to|check back later/i],
  ['"soon" as a promise', /\b(?:available|here|open|live) soon\b/i],
  [
    'a setting described as a future ("has not set … yet", "not set up yet", "no tier yet"): say what is true now',
    /\b(?:INTAFACED|we)\s+(?:has|have)\s+not\b[^.]*\byet\b|\bset(?!\s+aside)(?:\s+up)?\b[^.]*\byet\b|\bno tier yet\b|\b(?:switched on|published|configured)\b[^.]*\byet\b/i,
  ],
  ['a snake_case word', /\b[a-z]+(?:_[a-z0-9]+)+\b/],
  ['a service code', /\bpay\.[a-z_]+/],
];
// Developer pages may say "webhook", "endpoint" and "API": those are their subject, so they are not on the list above.

const entries = Object.entries(catalogs).flatMap(([namespace, messages]) =>
  Object.entries(messages).map(([key, text]) => [`${namespace}.${key}`, text] as const),
);

describe('merchant portal copy', () => {
  it('reads every portal namespace', () => {
    expect(Object.keys(catalogs).length).toBeGreaterThanOrEqual(9);
    expect(entries.length).toBeGreaterThan(900);
  });
  it('uses no engineer words', () => {
    const offenders: string[] = [];
    for (const [id, text] of entries) {
      // `{n}` and `{id}` are placeholders, not words.
      const words = text.replace(/\{[A-Za-z]+\}/g, '');
      for (const [name, pattern] of banned) if (pattern.test(words)) offenders.push(`${id} has ${name}: ${text}`);
    }
    expect(offenders).toEqual([]);
  });
  it('finds a banned word when there is one (the check can fail)', () => {
    expect(banned.some(([, pattern]) => pattern.test('Loaded from the backend'))).toBe(true);
    for (const promise of [
      'Not connected yet',
      'Not available yet',
      'Invitations are on the way',
      'We’ll try again soon',
      'You’ll be able to see it here',
      'Check back later.',
      'INTAFACED has not set limits for your account yet.',
      'Your checkout isn’t set up yet',
      'Your account has no tier yet.',
      'No pricing has been set for your account yet.',
      'INTAFACED has not published any tiers to compare with yet.',
    ])
      expect(
        banned.some(([, pattern]) => pattern.test(promise)),
        promise,
      ).toBe(true);
    // a status is not a promise
    expect(banned.some(([, pattern]) => pattern.test('Not paid out yet'))).toBe(false);
    expect(banned.some(([, pattern]) => pattern.test('No refunds yet'))).toBe(false);
    expect(banned.some(([, pattern]) => pattern.test('No limits are set on your account.'))).toBe(false);
    expect(banned.some(([, pattern]) => pattern.test('Your payments are in the list'))).toBe(false);
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
