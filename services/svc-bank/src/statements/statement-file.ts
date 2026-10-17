import { createHash, createHmac, hkdfSync } from 'node:crypto';
import type { ActivityItem } from '../activity/activity-service.js';

/**
 * A statement file of the customer's own posted lines.
 * Amounts stay the decimal strings the ledger sent. The file does not state a balance.
 * The signature is HMAC-SHA256 over the file bytes, under a key derived from the
 * service secret so the cursor key is not reused.
 */

const RISKY = /^[=+\-@\t\r]/;

function cell(value: string, text: boolean): string {
  const safe = text && RISKY.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

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
] as const;

export function signedAmount(item: Pick<ActivityItem, 'direction' | 'amount'>): string {
  return item.direction === 'out' && !/^0(\.0+)?$/.test(item.amount) ? `-${item.amount}` : item.amount;
}

export function statementCsv(items: readonly ActivityItem[]): string {
  const lines = [STATEMENT_CSV_HEADER.map((name) => cell(name, false)).join(',')];
  for (const item of items) {
    const when = Number.isFinite(Date.parse(item.postedAt)) ? new Date(item.postedAt).toISOString() : '';
    lines.push(
      [
        cell(when, false),
        cell(item.kind, true),
        cell(item.direction, false),
        cell(item.asset, true),
        cell(signedAmount(item), false),
        cell(item.counterparty ? `@${item.counterparty.handle}` : '', true),
        cell(item.spaceName ?? '', true),
        cell(item.txId, true),
        cell(item.id, true),
        cell(item.note ?? '', true),
        cell(item.reference ?? '', true),
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

/** One page of Courier text. Enough for a monthly statement the customer can open. */
export function statementPdf(lines: readonly string[]): Buffer {
  const commands = ['BT', '/F1 9 Tf', '40 760 Td', '12 TL'];
  lines.slice(0, 55).forEach((line, index) => {
    if (index === 0) commands.push(`(${pdfText(line)}) Tj`);
    else commands.push(`T* (${pdfText(line)}) Tj`);
  });
  commands.push('ET');
  const stream = commands.join('\n');
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n',
    `4 0 obj << /Length ${Buffer.byteLength(stream, 'utf8')} >> stream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Courier >> endobj\n',
  ];
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
}): string[] {
  const lines = [
    'INTAFACED account statement',
    'Proof of account: posted ledger lines for the holder below.',
    'This file lists posted lines. It does not state a balance.',
    `Holder: ${input.holderUserId}`,
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
