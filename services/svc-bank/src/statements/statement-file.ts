import { createHash, createHmac, hkdfSync } from 'node:crypto';
import type { ActivityItem } from '../activity/activity-service.js';

/**
 * A statement file of the customer's own posted lines.
 * Amounts stay the decimal strings the ledger sent. The file does not state a balance.
 * The signature is HMAC-SHA256 over the file bytes, under a key derived from the
 * service secret so the cursor key is not reused.
 */

const RISKY = /^[=+\-@\t\r]/;

/** One CSV cell. A free-text cell (`text`) that a spreadsheet would run as a formula is prefixed with `'`. */
export function csvCell(value: string, text: boolean): string {
  const safe = text && RISKY.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Every statement says so: it lists what happened and works out no gain, loss or tax. */
export const STATEMENT_NOT_TAX_FORM = 'This is not a tax form. It works out no gain, loss or tax.';

export const STATEMENT_CSV_HEADER = [
  'Date (UTC)',
  'Type',
  'Direction',
  'Asset',
  'Amount',
  'Counterparty',
  'Account',
  'Reference',
  'Record',
  'Note',
  'Payment reference',
  'Report description',
] as const;

export function signedAmount(item: Pick<ActivityItem, 'direction' | 'amount'>): string {
  return item.direction === 'out' && !/^0(\.0+)?$/.test(item.amount) ? `-${item.amount}` : item.amount;
}

export function statementCsv(items: readonly ActivityItem[]): string {
  const lines = [STATEMENT_CSV_HEADER.map((name) => csvCell(name, false)).join(',')];
  for (const item of items) {
    const when = Number.isFinite(Date.parse(item.postedAt)) ? new Date(item.postedAt).toISOString() : '';
    lines.push(
      [
        csvCell(when, false),
        csvCell(item.kind, true),
        csvCell(item.direction, false),
        csvCell(item.asset, true),
        csvCell(signedAmount(item), false),
        csvCell(item.counterparty ? `@${item.counterparty.handle}` : '', true),
        csvCell(item.spaceName ?? '', true),
        csvCell(item.txId, true),
        csvCell(item.id, true),
        csvCell(item.note ?? '', true),
        csvCell(item.reference ?? '', true),
        csvCell(item.reportDescription ?? '', true),
      ].join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function pdfText(value: string): string {
  const bytes: string[] = [];
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x28 || code === 0x29 || code === 0x5c) bytes.push(`\\${ch}`);
    else if (code >= 32 && code <= 126) bytes.push(ch);
    else bytes.push('?');
  }
  return bytes.join('');
}

/** Body lines on one page, besides the "Page i of n" line. About 55 lines of Courier fit a letter page. */
const PDF_BODY_LINES = 54;

/**
 * One page object and one content stream per page. Every line is drawn.
 * The header lines are the first lines of `lines`, so they land on page 1.
 * A file never drops a row: the caller refuses with `bank.statement_too_large`
 * before asking for a PDF it will not draw.
 */
export function statementPdf(lines: readonly string[]): Buffer {
  const pageCount = Math.max(1, Math.ceil(lines.length / PDF_BODY_LINES));
  const streams: string[] = [];
  for (let page = 0; page < pageCount; page += 1) {
    const chunk = lines.slice(page * PDF_BODY_LINES, (page + 1) * PDF_BODY_LINES);
    const drawn = [`Page ${page + 1} of ${pageCount}`, ...chunk];
    const commands = ['BT', '/F1 9 Tf', '40 760 Td', '12 TL'];
    drawn.forEach((line, index) => {
      if (index === 0) commands.push(`(${pdfText(line)}) Tj`);
      else commands.push(`T* (${pdfText(line)}) Tj`);
    });
    commands.push('ET');
    streams.push(commands.join('\n'));
  }
  const fontObject = 3 + pageCount * 2;
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    `2 0 obj << /Type /Pages /Kids [${streams.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pageCount} >> endobj\n`,
  ];
  streams.forEach((stream, index) => {
    const pageObject = 3 + index * 2;
    const contentsObject = pageObject + 1;
    objects.push(
      `${pageObject} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentsObject} 0 R /Resources << /Font << /F1 ${fontObject} 0 R >> >> >> endobj\n`,
    );
    objects.push(`${contentsObject} 0 obj << /Length ${Buffer.byteLength(stream, 'utf8')} >> stream\n${stream}\nendstream\nendobj\n`);
  });
  objects.push(`${fontObject} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Courier >> endobj\n`);
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, 'utf8'));
    body += object;
  }
  const xrefAt = Buffer.byteLength(body, 'utf8');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  body += xref;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(body, 'utf8');
}

export function statementLines(input: {
  holderUserId: string;
  from: string;
  to: string;
  generatedAt: string;
  rows: readonly ActivityItem[];
  /** `trades` heads the file as a trade history; every other report is the account statement. */
  report?: 'statement' | 'ledger' | 'trades';
  /** One named space: its lines only, and the header names it. */
  space?: { id: string; name: string };
}): string[] {
  const lines = [
    input.space ? 'INTAFACED space statement' : input.report === 'trades' ? 'INTAFACED trade history' : 'INTAFACED account statement',
    'Proof of account: posted ledger lines for the holder below.',
    'This file lists posted lines. It does not state a balance.',
    STATEMENT_NOT_TAX_FORM,
    `Holder: ${input.holderUserId}`,
    ...(input.space ? [`Space: ${input.space.name} (${input.space.id})`] : []),
    `Period: ${input.from} to ${input.to}`,
    `Generated: ${input.generatedAt}`,
    `Rows: ${input.rows.length}`,
    'Date (UTC) | Type | Direction | Asset | Amount | Reference',
  ];
  for (const item of input.rows) {
    lines.push(`${item.postedAt} | ${item.kind} | ${item.direction} | ${item.asset} | ${signedAmount(item)} | ${item.txId}`);
  }
  return lines;
}

const keyCache = new Map<string, Buffer>();

function statementKey(secret: string): Buffer {
  let key = keyCache.get(secret);
  if (key === undefined) {
    key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'bank.statement.file.v1', 32));
    keyCache.set(secret, key);
  }
  return key;
}

export function signStatement(secret: string, bytes: Buffer): { sha256: string; signature: string } {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signature: createHmac('sha256', statementKey(secret)).update(bytes).digest('hex'),
  };
}
