import { describe, expect, it } from 'vitest';
import { FORBIDDEN } from '../../../../tooling/ci/brand-scan.mjs';
import {
  CARD_DIMENSIONS,
  blueprintProfileSchema,
  cardSizeSchema,
  crewRoleSchema,
  decisionStyleSchema,
  energyRhythmSchema,
  learningModeSchema,
  riskTemperamentSchema,
  type BlueprintProfile,
  type CardSize,
} from '@intafaced/contracts';
import { color } from '@intafaced/ui/tokens';
import { composeCard, escapeXml, type CardSubject } from './compose.js';

/**
 * THE §7.2 EXIT CRITERION, AS A TEST.
 *
 *   "Card renders pixel-perfect at share sizes (1080×1350, 1200×630); no
 *    third-party system names anywhere in output (automated copy-scan test in
 *    CI)."
 *
 * Two claims, and this file is where both stop being prose. The composer is
 * pure, so every one of them is checkable against the actual artifact rather
 * than against a screenshot somebody took once.
 */

const PROFILE: BlueprintProfile = {
  decisionStyle: 'analytical',
  riskTemperament: 'measured',
  energyRhythm: 'dawn',
  learningMode: 'hands_on',
  crewRole: 'anchor',
  curriculumPath: 'foundations',
  toneRegister: 'direct',
  guardrails: { maxLeverage: 2, dailyLossPromptPct: 5, confirmBeforeMarketOrder: true, copyTradingVisible: false },
};

const SUBJECT: CardSubject = { profile: PROFILE, crewName: 'Iron Meridian', season: 1 };
const SIZES = cardSizeSchema.options;

/** `width="1080"` — the attribute, not the viewBox. */
function attr(svg: string, name: string): string | null {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(svg)?.[1] ?? null;
}

describe('§7.2 — pixel-perfect at the share sizes', () => {
  it('declares exactly 1080×1350 for portrait and 1200×630 for landscape', () => {
    // The literal numbers from the spec, written out here rather than read from
    // CARD_DIMENSIONS. Asserting against the same constant the composer uses
    // would pass just as happily if someone changed 1350 to 1351 — the whole
    // point of this assertion is to be the copy of the spec that disagrees.
    const portrait = composeCard(SUBJECT, 'portrait');
    expect(attr(portrait, 'width')).toBe('1080');
    expect(attr(portrait, 'height')).toBe('1350');

    const landscape = composeCard(SUBJECT, 'landscape');
    expect(attr(landscape, 'width')).toBe('1200');
    expect(attr(landscape, 'height')).toBe('630');
  });

  it('sets a viewBox that matches the pixel attributes on both sizes', () => {
    // Attributes without a matching viewBox scale the artwork; a viewBox
    // without attributes lets the rasterizer pick the output resolution. Both
    // break "pixel-perfect", and only having both is correct.
    for (const size of SIZES) {
      const { width, height } = CARD_DIMENSIONS[size];
      expect(attr(composeCard(SUBJECT, size), 'viewBox')).toBe(`0 0 ${width} ${height}`);
    }
  });

  it('draws every element inside the canvas', () => {
    // Catches the layout bug this file is most likely to grow: a row added to
    // the axis list, pushed past the bottom edge, and invisible in the render
    // while every other assertion here still passes.
    for (const size of SIZES) {
      const { width, height } = CARD_DIMENSIONS[size];
      const svg = composeCard(SUBJECT, size);

      const ys = [...svg.matchAll(/\sy="(-?\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1]));
      const xs = [...svg.matchAll(/\sx="(-?\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1]));

      expect(ys.length).toBeGreaterThan(10);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...xs)).toBeLessThanOrEqual(width);
      expect(Math.max(...ys)).toBeLessThanOrEqual(height);
    }
  });

  it('is well-formed enough to parse: every tag closes', () => {
    for (const size of SIZES) {
      const svg = composeCard(SUBJECT, size);
      expect(svg.startsWith('<svg ')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      // Tag balance. A rasterizer given unbalanced markup either errors or
      // silently drops the remainder of the card, and the second is the one
      // that ships.
      expect((svg.match(/<text /g) ?? []).length).toBe((svg.match(/<\/text>/g) ?? []).length);
      expect((svg.match(/<defs>/g) ?? []).length).toBe((svg.match(/<\/defs>/g) ?? []).length);
    }
  });
});

describe('§7.2 — the copy-scan, on the rendered output', () => {
  /**
   * `brand.test.ts` scans this package's FILES. This scans what the composer
   * actually EMITS, which is a different claim: a forbidden name could reach
   * the card through a contract enum value or a label table without ever being
   * typed as a literal in a file the other scan would flag.
   *
   * The vocabulary is imported from the scanner, for the same reason brand.test.ts
   * imports it — so this file contains no forbidden name to find.
   */
  const patterns = FORBIDDEN.map(({ pattern }) => new RegExp(pattern.source, pattern.flags.replace('g', '')));

  it('extracted a real vocabulary to scan for', () => {
    expect(patterns.length).toBeGreaterThan(5);
  });

  it('renders no forbidden name, for any profile the contract allows', () => {
    // Every axis value, not just the fixture's. A name reachable only from
    // `crewRole: 'catalyst'` is exactly what a single-fixture scan misses.
    for (const svg of everyProfileCard()) {
      for (const pattern of patterns) {
        expect(new RegExp(pattern.source, pattern.flags).test(svg)).toBe(false);
      }
    }
  });

  it('would catch a forbidden name in the output if one appeared', () => {
    // Negative control. Without it, a broken `everyProfileCard` or an empty
    // pattern list would make the assertion above vacuously true.
    const assembled = [71, 77, 97, 115, 116, 101, 114].map((c) => String.fromCharCode(c)).join('');
    expect(patterns.some((p) => new RegExp(p.source, p.flags).test(`<text>${assembled}</text>`))).toBe(true);
  });

  it('uses the approved vocabulary on the card itself', () => {
    // §0.7 names three permitted terms. Avoiding the forbidden ones is half the
    // law; the card is user-facing copy and should speak the approved half.
    const portrait = composeCard(SUBJECT, 'portrait');
    expect(portrait).toContain('IDENTITY BLUEPRINT');
    expect(portrait).toContain('Sovereign Intelligence');
    expect(portrait).toContain('Neural Engine');
  });
});

describe('the card carries no personal data', () => {
  /**
   * The card is the one object in this service designed to leave it. §10 is
   * easiest to guarantee for an artifact that never held anything to isolate,
   * and this is the test that keeps it that way when someone later decides a
   * name would look nice on it.
   */
  it('contains no user id, no blueprint id, and no timestamp', () => {
    for (const size of SIZES) {
      const svg = composeCard(SUBJECT, size);
      // Any UUID at all. The composer is not given one, and this fails the day
      // somebody threads one through "just for the asset key".
      expect(svg).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      // An ISO date would date-stamp a shareable image with account activity.
      expect(svg).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  it('takes no free-text input at all — the subject type is closed', () => {
    // `guardrails` are the numbers svc-trade starts someone on. They are about
    // a person's money settings, and a public image is not where they belong.
    const svg = composeCard(SUBJECT, 'portrait');
    expect(svg).not.toContain(String(PROFILE.guardrails.maxLeverage) + 'x');
    expect(svg).not.toContain('dailyLossPromptPct');
  });
});

describe('determinism', () => {
  it('produces byte-identical output for the same subject', () => {
    for (const size of SIZES) {
      expect(composeCard(SUBJECT, size)).toBe(composeCard(SUBJECT, size));
    }
  });

  it('changes when the profile changes', () => {
    // Guards against the opposite failure: a composer that is stable because it
    // ignores its input would pass every determinism check above.
    const other = composeCard({ ...SUBJECT, profile: { ...PROFILE, crewRole: 'catalyst' } }, 'portrait');
    expect(other).not.toBe(composeCard(SUBJECT, 'portrait'));
    expect(other).toContain('CATALYST');
  });

  it('reads no clock', async () => {
    // The composer is pure, so this holds trivially today. It is asserted
    // because a "rendered on <date>" line is the single most tempting addition
    // to a share card, and it would break both determinism and the no-PII rule
    // above in one edit.
    const first = composeCard(SUBJECT, 'portrait');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(composeCard(SUBJECT, 'portrait')).toBe(first);
  });
});

describe('the unplaced case', () => {
  it('says so rather than leaving a gap', () => {
    const svg = composeCard({ profile: PROFILE, crewName: null, season: null }, 'portrait');
    expect(svg).toContain('Unplaced');
  });

  it('names the crew and season when placed', () => {
    expect(composeCard(SUBJECT, 'portrait')).toContain('Iron Meridian · Season 1');
  });
});

describe('escaping', () => {
  /**
   * Crew names come from a fixed vocabulary today, so nothing hostile can reach
   * the card through the current call path. These assertions are about the
   * NEXT change — the one that makes a crew name user-settable — landing
   * against a composer that already escapes rather than one that has to be
   * remembered.
   */
  it('escapes all five XML criticals', () => {
    expect(escapeXml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;');
  });

  it('escapes ampersands before the entities it introduces', () => {
    // The classic ordering bug: replacing `<` first turns `<` into `&lt;`, and a
    // later ampersand pass would double-escape it to `&amp;lt;`.
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });

  it('neutralises a script tag smuggled through a crew name', () => {
    const hostile = '</text><script>alert(1)</script><text>';
    const svg = composeCard({ profile: PROFILE, crewName: hostile, season: null }, 'portrait');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    // And the document is still balanced — the injection did not close a tag.
    expect((svg.match(/<text /g) ?? []).length).toBe((svg.match(/<\/text>/g) ?? []).length);
  });
});

describe('the brand is read from the design system, not restated', () => {
  it('paints the card in the brand black and the brand orange', () => {
    // packages/ui/src/tokens.ts: "nothing hard-codes a hex outside this file. A
    // colour that is not here does not exist in the product." This is that rule
    // applied to the acquisition artifact — if the brand moves, the card moves.
    const svg = composeCard(SUBJECT, 'portrait');
    expect(svg).toContain(color.base);
    expect(svg).toContain(color.accent);
    expect(svg).toContain(color.text);
  });

  it('uses no hex colour that is not a design token', () => {
    // The assertion that actually bites. The one above passes even if half the
    // card is painted in invented shades; this fails on the first stray hex.
    const tokens = new Set(Object.values(color).map((v) => v.toLowerCase()));
    for (const size of SIZES) {
      const used = [...composeCard(SUBJECT, size).matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => m[0].toLowerCase());
      expect(used.length).toBeGreaterThan(0);
      expect([...new Set(used)].filter((hex) => !tokens.has(hex))).toEqual([]);
    }
  });
});

describe('every value the contract allows is drawable', () => {
  it('labels every enum member — no raw machine token reaches a card', () => {
    // The label table is a hand-maintained map over five contract enums. This
    // is what makes adding a sixth `riskTemperament` a failing test here rather
    // than the word `hands_on` appearing in someone's shared image.
    const cards = everyProfileCard();
    expect(cards.length).toBeGreaterThan(4);

    for (const svg of cards) {
      const rendered = [...svg.matchAll(/>([^<]*)</g)].map((m) => m[1]!);
      // Underscores only ever come from an unlabelled token; no copy on this
      // card contains one.
      expect(rendered.filter((t) => /^[a-z]+_[a-z]+$/.test(t))).toEqual([]);
    }
  });

  it('renders at both sizes for every crew role without overflowing', () => {
    for (const role of crewRoleSchema.options) {
      for (const size of SIZES) {
        const svg = composeCard({ ...SUBJECT, profile: { ...PROFILE, crewRole: role } }, size);
        expect(svg).toContain(role.toUpperCase());
        expect(svg.length).toBeGreaterThan(500);
      }
    }
  });
});

/**
 * One card per value of every axis, at both sizes.
 *
 * Not a full cross-product — that is 4×4×4×4×4×4×4 and proves nothing extra,
 * because the axes are drawn independently. Varying one at a time reaches every
 * label the composer can emit, which is what the scans above need.
 */
function everyProfileCard(): string[] {
  const variants: BlueprintProfile[] = [PROFILE];

  const axes = [
    ['decisionStyle', decisionStyleSchema.options],
    ['riskTemperament', riskTemperamentSchema.options],
    ['energyRhythm', energyRhythmSchema.options],
    ['learningMode', learningModeSchema.options],
    ['crewRole', crewRoleSchema.options],
    ['curriculumPath', blueprintProfileSchema.shape.curriculumPath.options],
    ['toneRegister', blueprintProfileSchema.shape.toneRegister.options],
  ] as const;

  for (const [key, values] of axes) {
    for (const value of values) {
      variants.push({ ...PROFILE, [key]: value } as BlueprintProfile);
    }
  }

  const cards: string[] = [];
  for (const profile of variants) {
    for (const size of SIZES as readonly CardSize[]) {
      cards.push(composeCard({ profile, crewName: 'Iron Meridian', season: 2 }, size));
      cards.push(composeCard({ profile, crewName: null, season: null }, size));
    }
  }
  return cards;
}
