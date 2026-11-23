/**
 * What a customer reads in a drawn room: no raw id, internal code or placeholder address (shared/reference.ts,
 * `rawTextIn`). render.compare.tsx holds every room the look gate draws to it. A long id is shown through
 * <ShortReference> (shared/ShortReference.tsx), a refusal code through its sentence (the code stays on a `data-*`
 * attribute), and a test machine's address in words. The developer rooms document the API's own codes and are left out.
 */
import { rawTextIn } from '../../shared/reference';

const DEVELOPER_ROOMS = /^\/developers(\/|$)/;
/** The render harness's own origin: in the app it is the page's origin (a payment link, a badge), never a placeholder. */
const HARNESS_ORIGIN = 'http://localhost:3000';
/** Text a journey's step words have the customer read, so it stays: each value with the step that names it. */
const NAMED_BY_STEPS: Record<string, string> = {
  'risk.approvals_source_unset': 'J-home-ia-12 #6: Approvals says the inbox is not connected "with the code"',
  'risk.incident_feed_unset': 'J-home-ia-12 #6: a feed that cannot be read says so "with code"',
};
/** The look gate's TEST account's own UID, shown whole on Account (J-identity-10 #1: "The UID in mono type with a Copy button"). */
const OWN_UID = { value: '00000000-0000-4000-8000-000000000001', rooms: new Set(['/uc', '/uc/account']) };

/** The text a person sees: drawings, styles, screen-reader-only text, a closed disclosure's body and every tag and attribute removed. */
export function visibleText(html: string): string {
  return (
    html
      .replace(/<(svg|style|script)\b[\s\S]*?<\/\1>/gi, ' ')
      // Screen-reader-only text (`lt-sr`) is not on screen.
      .replace(/<(\w+)\b[^>]*\bclass="[^"]*\blt-sr\b[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, ' ')
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
      .replace(/\s+/g, ' ')
  );
}

/** The raw text a drawn part shows that no customer should read; `room` is the part's route or state name. */
export function rawCustomerText(room: string, html: string): string[] {
  if (DEVELOPER_ROOMS.test(room)) return [];
  const path = room.split(/[?#]/)[0] ?? room;
  return rawTextIn(visibleText(html)).filter(
    (value) => !(value in NAMED_BY_STEPS) && !(value === OWN_UID.value && OWN_UID.rooms.has(path)),
  );
}
