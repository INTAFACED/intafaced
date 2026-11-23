/**
 * What a customer reads, room by room: the text of every recorded room (render-record/, which render.compare.tsx holds
 * equal to what the app draws) carries no raw id, internal code or placeholder address. A long id is shown through
 * <ShortReference> (shared/ShortReference.tsx), a refusal code through its sentence (the code stays on a `data-*` attribute), and a
 * test machine's address in words. The developer rooms document the API's own codes and are left out.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rawTextIn } from '../../shared/reference';

const DIR = 'render-record';
const DEVELOPER_ROOMS = /^developers(__|\.html$)/;
/** The render harness's own origin: in the app it is the page's origin (a payment link, a badge), never a placeholder. */
const HARNESS_ORIGIN = 'http://localhost:3000';
/** Text a journey's step words have the customer read, so it stays: each value with the step that names it. */
const NAMED_BY_STEPS: Record<string, string> = {
  'risk.approvals_source_unset': 'J-home-ia-12 #6: Approvals says the inbox is not connected "with the code"',
  'risk.incident_feed_unset': 'J-home-ia-12 #6: a feed that cannot be read says so "with code"',
};
/** The look gate's TEST account's own UID, shown whole on Account (J-identity-10 #1: "The UID in mono type with a Copy button"). */
const OWN_UID = { value: '00000000-0000-4000-8000-000000000001', rooms: new Set(['uc.html', 'uc__account.html']) };

/** The text a person sees: drawings, styles, a closed disclosure's body and every tag and attribute removed. */
export function visibleText(html: string): string {
  return html
    .replace(/<(svg|style|script)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(
      /<details\b(?![^>]*\bopen\b)[^>]*>([\s\S]*?)<\/details>/gi,
      (_all, body: string) => body.match(/<summary\b[\s\S]*?<\/summary>/i)?.[0] ?? ' ',
    )
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replaceAll(HARNESS_ORIGIN, 'https://app')
    .replace(/\s+/g, ' ');
}

describe('no customer room shows a raw id, an internal code or a placeholder address', () => {
  it('finds each kind it is meant to stop, and passes plain words', () => {
    expect(rawTextIn('Personal account · 8a96885b-cd8f-4a1e-9b1c-0123456789ab')).toEqual(['8a96885b-cd8f-4a1e-9b1c-0123456789ab']);
    expect(rawTextIn('Paid plans need a plan fee (bank.plan_fee_unwired).')).toEqual(['bank.plan_fee_unwired']);
    expect(rawTextIn('domains official-test.invalid and http://127.0.0.1:3210/help')).toEqual(['official-test.invalid', '127.0.0.1']);
    expect(rawTextIn('pool 198.51.100.1:3999')).toEqual(['198.51.100.1']);
    expect(rawTextIn('Reference 8A96885B · e.g. a price · 1.5 BTC · beta.intafaced.com · not shown as served')).toEqual([]);
    expect(visibleText('<details><summary>Details</summary>id 8a96885b-cd8f-4a1e-9b1c-0123456789ab</details>')).toBe(' Details ');
  });

  const rooms = readdirSync(DIR).filter((f) => f.endsWith('.html') && !DEVELOPER_ROOMS.test(f));
  it.each(rooms)('%s', (file) => {
    const found = rawTextIn(visibleText(readFileSync(`${DIR}/${file}`, 'utf8'))).filter(
      (value) => !(value in NAMED_BY_STEPS) && !(value === OWN_UID.value && OWN_UID.rooms.has(file)),
    );
    expect(found, `${file} shows text no customer should read`).toEqual([]);
  });
});
