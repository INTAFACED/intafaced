import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The venue spot desk only composes: when every journey drew its panel, ticket or dialog inside VenueSpotDesk.tsx,
 * parallel builds collided in that one file. Each part now lives in its own file in this folder
 * (VenueSideForm, VenueAccountPanel, VenueReviewRows, VenuePending, VenueVerifyDesk, VenueSpotGate) and the desk mounts
 * it with one line.
 */
const DESK = 'VenueSpotDesk.tsx';
const MAX_LINES = 600;

/** Why a version of VenueSpotDesk.tsx breaks the desk's shape, each with where the code goes instead. */
function deskShapeProblems(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split('\n').length;
  if (lines > MAX_LINES)
    problems.push(
      `${DESK} has ${lines} lines (at most ${MAX_LINES}): move a panel, ticket or dialog into its own Venue<Name>.tsx in this folder and mount it with one line`,
    );
  for (const m of text.matchAll(/^(?:export\s+)?(?:function|const)\s+([A-Z][a-z0-9][\w$]*)/gmu)) {
    if (m[1] === 'VenueSpotDesk') continue;
    problems.push(
      `${DESK} defines ${m[1]}: a component other than VenueSpotDesk goes in its own Venue<Name>.tsx in this folder (as VenueSideForm.tsx and VenueAccountPanel.tsx are)`,
    );
  }
  return problems;
}

describe('the venue spot desk only composes', () => {
  it('VenueSpotDesk.tsx defines one component and stays short', () => {
    expect(deskShapeProblems(readFileSync(new URL(`./${DESK}`, import.meta.url), 'utf8'))).toEqual([]);
  });

  it('refuses a component drawn inside the desk file, naming where it goes', () => {
    const problems = deskShapeProblems('export function VenueSpotDesk() {}\nfunction VenueSideForm() {}\nconst Panel = () => null;\n');
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('VenueSideForm');
    expect(problems[1]).toContain('Venue<Name>.tsx');
  });

  it('refuses a desk file grown past its line limit', () => {
    const problems = deskShapeProblems(`export function VenueSpotDesk() {}\n${'\n'.repeat(MAX_LINES)}`);
    expect(problems).toEqual([expect.stringContaining(`at most ${MAX_LINES}`)]);
  });
});
