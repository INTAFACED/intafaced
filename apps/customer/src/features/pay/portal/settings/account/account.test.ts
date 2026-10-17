import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { portalMessages } from '../../copy';
import { extensionMessages } from '../../extension-copy';
import { layoutMessages } from '../../home-layout/copy';
import { knownRefusalCodes } from '../../refusal';
import { w3cMessages } from '../../w3c-copy';
import { settingsMessages } from '../copy';
import { accountMessages } from './copy';
import './refusals';

const root = fileURLToPath(new URL('..', import.meta.url));
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) && !/copy\.ts$|\.test\.tsx?$/.test(name) ? [full] : [];
  });

describe('account copy', () => {
  const banned: Array<[string, RegExp]> = [
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
    ['"coming soon"', /coming soon/i],
    ['a snake_case word', /\b[a-z]+(?:_[a-z0-9]+)+\b/],
    ['a service code', /\bpay\.[a-z_]+/],
  ];
  it('uses no engineer words and never captions anything "coming soon"', () => {
    const offenders: string[] = [];
    for (const [key, text] of Object.entries(accountMessages)) {
      const words = text.replace(/\{[A-Za-z]+\}/g, '');
      for (const [name, pattern] of banned) if (pattern.test(words)) offenders.push(`${key} has ${name}: ${text}`);
    }
    expect(offenders).toEqual([]);
  });
  it('shares no key with another catalog, so a word never reads two ways', () => {
    const others = new Set(
      [portalMessages, w3cMessages, extensionMessages, layoutMessages, settingsMessages].flatMap((m) => Object.keys(m)),
    );
    expect(Object.keys(accountMessages).filter((k) => others.has(k))).toEqual([]);
  });
  it('has no key that nothing refers to', () => {
    const text = sources(root)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const prefixes = [...text.matchAll(/`([A-Za-z0-9_]+)\$\{/g)].map((m) => m[1]!);
    const dead = Object.keys(accountMessages).filter(
      (key) => !new RegExp(`['"\`]${key}['"\`]`).test(text) && !prefixes.some((p) => key.startsWith(p)),
    );
    expect(dead).toEqual([]);
  });
  it('never shows a vendor name', () => {
    expect(Object.values(accountMessages).join(' ')).not.toMatch(/sumsub|onfido|persona|jumio|veriff|stripe/i);
  });
});

describe('account refusals', () => {
  it('gives every profile and network refusal plain words', () => {
    const known = new Set(knownRefusalCodes());
    for (const code of [
      'pay.profile_interactive_only',
      'pay.profile_version_conflict',
      'pay.profile_kyb_pending',
      'pay.profile_change_pending',
      'pay.profile_self_approval',
      'pay.profile_withdraw_forbidden',
      'pay.profile_field_invalid',
      'pay.submerchant_grant_lateral',
      'pay.submerchant_user_already_merchant',
    ])
      expect(known.has(code), code).toBe(true);
  });
});

describe('account pages', () => {
  it('never reach for the founder or operator panel', () => {
    const offenders = sources(root).filter((f) => /founderAdmin|apps\/admin/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('only ask for a money confirmation through PortalReview', () => {
    const offenders = sources(root).filter((f) => /\bReviewedAction\b/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
