/**
 * A short, readable stand-in for a long identifier. Customers can quote it to support; the full value stays behind a
 * "Details" disclosure, in a tooltip or in a copy button, never in body copy.
 */
export function shortReference(id: string): string {
  return id
    .replace(/[^0-9a-z]/gi, '')
    .slice(0, 8)
    .toUpperCase();
}

/**
 * A host no customer can reach: a reserved test name (`.invalid`, `.test`, `.example`, `localhost`), the loopback
 * address or a documentation range (192.0.2.x, 198.51.100.x, 203.0.113.x). A test stack's stand-in address is one of
 * these; a room never offers one to copy or to trust, and says the address is not published instead.
 */
export function isPlaceholderAddress(value: string): boolean {
  const host = value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/]*@/, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .toLowerCase();
  return (
    host === 'localhost' ||
    /\.(invalid|test|example|localhost)$/.test(host) ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/.test(host) ||
    host === '0.0.0.0' ||
    host === '[::1]'
  );
}

/** What no customer reads: each kind with the pattern that finds it in a room's text. */
const RAW_TEXT: readonly { kind: string; pattern: RegExp }[] = [
  { kind: 'a raw id (a UUID)', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { kind: 'an internal code (service.reason_code)', pattern: /\b[a-z][a-z0-9]*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g },
  { kind: 'a placeholder host', pattern: /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.invalid\b/gi },
  { kind: 'a loopback or documentation address', pattern: /\b(?:127\.0\.0\.1|(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3})\b/g },
];

/** The raw ids, internal codes and placeholder addresses in `text`, in the order they appear. */
export function rawTextIn(text: string): string[] {
  const found: { at: number; value: string }[] = [];
  for (const { pattern } of RAW_TEXT) for (const m of text.matchAll(pattern)) found.push({ at: m.index ?? 0, value: m[0] });
  return found.sort((a, b) => a.at - b.at).map((f) => f.value);
}
