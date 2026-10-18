// The checks on the words a page RENDERS, shared by the crawler and its unit test. TEST data throughout.
// What a person must never read, checked on the text the page RENDERS (copy files are linted separately, but copy
// files cannot see an enum, a status code or a count that only exists at run time).
/** Words an engineer would use. */
const ENGINEER_WORDS = [
  [/\breturned\b/i, 'the word "returned"'],
  [/\bthe service\b/i, '"the service"'],
  [/\bcapabilit(?:y|ies)\b/i, 'the word "capability"'],
  [/\bbasis points?\b/i, '"basis points"'],
  [/\bpayload\b/i, 'the word "payload"'],
  [/\bnull\b|\bundefined\b/, '"null" or "undefined"'],
];
/** A snake_case token. Key prefixes the page shows on purpose (test_ab12, ifs_...) are not words, so they are let through. */
const SNAKE = /\b(?!(?:test|live|ifs|pk|sk)_)[a-z]+(?:_[a-z0-9]+)+\b/;
/** An HTTP status in the text: "(503)", "status 404", "HTTP 500", "error 502". */
const HTTP_CODE = /\((?:4|5)\d\d\)|\b(?:HTTP|status|error|code)\s*:?\s*(?:4|5)\d\d\b/i;
const PLURAL_HEDGE = /\b[A-Za-z]+\((?:s|es)\)/;
const COUNTED = [
  'payment',
  'subscription',
  'customer',
  'link',
  'refund',
  'settlement',
  'payout',
  'dispute',
  'invoice',
  'webhook',
  'key',
  'member',
  'approval',
  'export',
  'delivery',
  'deliveries',
  'endpoint',
  'change',
  'event',
  'record',
  'mandate',
  'destination',
  'invitation',
  'file',
];
const pluralOf = (noun) => (noun === 'delivery' ? 'deliveries' : `${noun}s`);
/** Raw enum values standing alone on a line, where a chip or a status cell would be: they should be words. */
const RAW_ENUM_LINE =
  /^(?:active|approved|pending|pending_review|failed|captured|settled|refunded|disputed|owner|admin|finance|developer|viewer|posted|paid_out|ready|expired|queued|running|sandbox|gateway|payfac|delivered|dead|void|draft|sent|paid|open|contested|won|lost|accepted|reversed|rejected|consumed|voided|authorized|created|cancelled|completed)$/m;

/** The checks that need the rendered words. Returns the sentences to report. */
export function lintRenderedText(text, _path = '') {
  const out = [];
  // Webhook event names (payment.captured, settlement.paid_out) are the API's own names, shown as such on the developer pages.
  const snake = text
    .replace(/\b(?:payment|settlement|refund|dispute|invoice|payout|subscription|export|approval)\.[a-z_.]+\b/g, '')
    .match(SNAKE);
  if (snake) out.push(`snake_case word "${snake[0]}"`);
  const http = text.match(HTTP_CODE);
  if (http) out.push(`HTTP code "${http[0]}"`);
  const hedge = text.match(PLURAL_HEDGE);
  if (hedge) out.push(`plural hedge "${hedge[0]}"`);
  for (const noun of COUNTED) {
    const plural = pluralOf(noun);
    const one = text.match(new RegExp(`(?<![\\w.,])1 ${plural}\\b`));
    if (one) out.push(`"${one[0]}" (should be "1 ${noun}")`);
    if (noun !== 'delivery') {
      const many = text.match(new RegExp(`(?<![\\w.,])(?:0|[2-9]|\\d{2,}) ${noun}(?![A-Za-z])(?! [A-Za-z])`));
      if (many) out.push(`"${many[0]}" (should be "${many[0].replace(noun, plural)}")`);
    }
  }
  for (const [pattern, name] of ENGINEER_WORDS) {
    const m = text.match(pattern);
    if (m) out.push(`${name}: "${m[0]}"`);
  }
  // "Dispute response due" is a business word; "outside this response" is an engineer talking about a reply.
  const reply = text.match(/\b(?:outside|in|from|of) (?:this|the) response\b/i);
  if (reply) out.push(`the word "response": "${reply[0]}"`);
  const raw = text.match(RAW_ENUM_LINE);
  if (raw) out.push(`a raw value on a line of its own: "${raw[0]}"`);
  return out;
}
