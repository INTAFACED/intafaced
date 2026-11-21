import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOT_OFFERED } from './not-offered.js';

/**
 * venue.ts was changed by 16 merged PRs in 7 days (project-state #2655): each venue contract change added a read, a
 * `not_offered` case or an unread market term there. Each now has a home of its own; this keeps them out of venue.ts.
 */
const source = (file: string): string => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
const venue = source('venue.ts');
/** The class body of `HyperliquidTestnetUserVenue`, where a member is a two-space-indented name. */
const venueClass = venue.slice(venue.indexOf('export class HyperliquidTestnetUserVenue'));
const reads = source('reads.ts');

/** The signed side's own members: preview, prepare, submit and what they build with. */
const VENUE_OWN = ['constructor', 'preview', 'prepare', 'build', 'buildOwn', 'orderWire', 'submit', 'outcomeOf', 'post'];

describe('the Hyperliquid adapter keeps each kind of change in its own file (project-state #2655)', () => {
  it('venue.ts declares only the signed side: a new read goes in reads.ts', () => {
    const members = [...venueClass.matchAll(/^ {2}(?:(?:private|protected|public|async|static|readonly) )*(\w+)\s*[(<]/gm)].map(
      (m) => m[1],
    );
    expect(
      members.filter((m) => !VENUE_OWN.includes(m!)),
      'a UserVenue read goes in src/reads.ts (HyperliquidReads), never in venue.ts',
    ).toEqual([]);
  });

  it('venue.ts writes no "not offered" refusal of its own: a kind this adapter does not build goes in not-offered.ts', () => {
    expect(
      venue.match(/case '\w+':\s*(?:\/\/[^\n]*\n\s*)*throw refusal\(venueId, 'not_offered'/g),
      "an intent kind this adapter does not build is one line in NOT_OFFERED (src/not-offered.ts), never a case in venue.ts' switch",
    ).toBeNull();
    for (const [kind, why] of Object.entries(NOT_OFFERED)) expect(why, kind).toMatch(/not offered/);
  });

  it('the terms markets() reads hold no unknown or null of their own: an unread term goes in market-terms.ts', () => {
    const read = /const read: ReadMarketTerms = \{([\s\S]*?)\n {6}\};/.exec(reads)?.[1];
    expect(read, 'reads.ts builds the terms it reads as `const read: ReadMarketTerms = { … }`').toBeDefined();
    expect(
      read!.match(/^\s*\w+: (?:null|\{ known: false \}),/gm),
      'a market term this adapter does not read is one line in unreadMarketTerms (src/market-terms.ts), not known or null there',
    ).toBeNull();
  });
});
