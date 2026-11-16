import { formatAmount } from '@intafaced/ledger-client';
import { csvCell } from '../statements/statement-file.js';

/**
 * A business's statement as four files (J-bank-23 #3; BK-bexp-05): CSV, SWIFT MT940, ISO 20022 CAMT.053 and QIF. Each is
 * made from the same lines and the same opening and closing balance, so each carries the partner statement's closing
 * balance and line count, and every line carries its id (the partner's own reference for it).
 *
 * Amounts are scaled bigints in, decimal strings out: never a `number`.
 */

export const BOOK_STATEMENT_FORMATS = ['csv', 'mt940', 'camt053', 'qif'] as const;
export type BookStatementFormat = (typeof BOOK_STATEMENT_FORMATS)[number];

export interface BookLine {
  /** The partner's own reference for the line. */
  readonly id: string;
  readonly bookedAt: Date;
  /** Signed: money in above zero, money out below. */
  readonly amount: bigint;
  readonly payee: string;
  readonly category: string | null;
  readonly glCode: string | null;
}

export interface BookStatement {
  /** The business's account id. */
  readonly accountId: string;
  readonly accountName: string;
  readonly currency: string;
  /** Whose record this is, e.g. "TEST partner bank". */
  readonly servicer: string;
  readonly from: Date;
  /** Exclusive. */
  readonly to: Date;
  readonly opening: bigint;
  readonly closing: bigint;
  /** Oldest first. */
  readonly lines: readonly BookLine[];
  readonly generatedAt: Date;
}

export interface BookFile {
  readonly format: BookStatementFormat;
  readonly fileName: string;
  readonly contentType: string;
  readonly body: Buffer;
}

const abs = (v: bigint) => (v < 0n ? -v : v);
const iso = (d: Date) => d.toISOString();
const day = (d: Date) => d.toISOString().slice(0, 10);
/** The last instant inside an exclusive end. */
const lastDay = (s: BookStatement) => new Date(Math.max(s.from.getTime(), s.to.getTime() - 1));
const yymmdd = (d: Date) => day(d).slice(2).replace(/-/g, '');

export function renderBookStatement(s: BookStatement, format: BookStatementFormat): BookFile {
  const stem = `statement-${s.accountId.slice(0, 8)}-${day(s.from)}-${day(lastDay(s))}`;
  switch (format) {
    case 'csv':
      return { format, fileName: `${stem}.csv`, contentType: 'text/csv; charset=utf-8', body: Buffer.from(bookCsv(s), 'utf8') };
    case 'mt940':
      return { format, fileName: `${stem}.sta`, contentType: 'text/plain; charset=us-ascii', body: Buffer.from(bookMt940(s), 'ascii') };
    case 'camt053':
      return { format, fileName: `${stem}.xml`, contentType: 'application/xml; charset=utf-8', body: Buffer.from(bookCamt053(s), 'utf8') };
    case 'qif':
      return { format, fileName: `${stem}.qif`, contentType: 'application/qif; charset=utf-8', body: Buffer.from(bookQif(s), 'utf8') };
  }
}

/** Two cells a row: the statement's own facts first, then one row per line under its header. */
export function bookCsv(s: BookStatement): string {
  const rows: string[][] = [
    ['Account', s.accountName],
    ['Account id', s.accountId],
    ['Currency', s.currency],
    ['Held by', s.servicer],
    ['Period from (UTC)', iso(s.from)],
    ['Period to (UTC, exclusive)', iso(s.to)],
    ['Opening balance', formatAmount(s.opening)],
    ['Closing balance', formatAmount(s.closing)],
    ['Line count', String(s.lines.length)],
    [],
    ['Line id', 'Booked (UTC)', 'Amount', 'Currency', 'Payee', 'Category', 'GL code'],
  ];
  for (const l of s.lines) {
    rows.push([l.id, iso(l.bookedAt), formatAmount(l.amount), s.currency, l.payee, l.category ?? '', l.glCode ?? '']);
  }
  return `﻿${rows.map((r) => r.map((c, i) => csvCell(c, i !== 2)).join(',')).join('\r\n')}\r\n`;
}

/** The SWIFT X character set; anything else becomes a full stop. */
const swift = (v: string, max: number) => v.replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, '.').slice(0, max);
const mtAmount = (v: bigint) => formatAmount(abs(v)).replace('.', ',') + (formatAmount(abs(v)).includes('.') ? '' : ',');
const mtMark = (v: bigint) => (v < 0n ? 'D' : 'C');

/** SWIFT MT940: :60F: opening, one :61: and :86: per line (the line id in :86:), :62F: closing. */
export function bookMt940(s: BookStatement): string {
  const out = [
    `:20:${swift(`STMT${yymmdd(s.from)}`, 16)}`,
    `:25:${swift(s.accountId.replace(/-/g, ''), 35)}`,
    ':28C:00001/001',
    `:60F:${mtMark(s.opening)}${yymmdd(s.from)}${s.currency}${mtAmount(s.opening)}`,
  ];
  for (const l of s.lines) {
    const date = yymmdd(l.bookedAt);
    out.push(`:61:${date}${date.slice(2)}${l.amount < 0n ? 'D' : 'C'}${mtAmount(l.amount)}NTRFNONREF`);
    out.push(`:86:/ID/${swift(l.id, 60)}`);
    out.push(`/NAME/${swift(l.payee, 59)}`);
    if (l.category) out.push(`/CAT/${swift(l.category, 60)}`);
    if (l.glCode) out.push(`/GL/${swift(l.glCode, 61)}`);
  }
  out.push(`:62F:${mtMark(s.closing)}${yymmdd(lastDay(s))}${s.currency}${mtAmount(s.closing)}`);
  return `${out.join('\r\n')}\r\n-\r\n`;
}

/** XML 1.0 takes no control character but tab, line feed and carriage return: the rest are left out. */
const xmlChar = (c: string) => c.charCodeAt(0) >= 0x20 || c === '\t' || c === '\n' || c === '\r';
const xml = (v: string) =>
  [...v]
    .filter(xmlChar)
    .join('')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** ISO 20022 CAMT.053 (version 08): an OPBD and a CLBD balance, the entry count, and one Ntry per line under its id. */
export function bookCamt053(s: BookStatement): string {
  const amt = (v: bigint) => `<Amt Ccy="${xml(s.currency)}">${formatAmount(abs(v))}</Amt>`;
  const ind = (v: bigint) => `<CdtDbtInd>${v < 0n ? 'DBIT' : 'CRDT'}</CdtDbtInd>`;
  const bal = (code: string, v: bigint, d: Date) =>
    `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp>${amt(v)}${ind(v)}<Dt><Dt>${day(d)}</Dt></Dt></Bal>`;
  const sum = s.lines.reduce((t, l) => t + abs(l.amount), 0n);
  const net = s.closing - s.opening;
  const entries = s.lines.map(
    (l) =>
      `<Ntry><NtryRef>${xml(l.id)}</NtryRef>${amt(l.amount)}${ind(l.amount)}<Sts><Cd>BOOK</Cd></Sts>` +
      `<BookgDt><DtTm>${iso(l.bookedAt)}</DtTm></BookgDt><BkTxCd><Prtry><Cd>TRANSFER</Cd></Prtry></BkTxCd>` +
      `<NtryDtls><TxDtls><Refs><AcctSvcrRef>${xml(l.id)}</AcctSvcrRef></Refs>` +
      `<RltdPties><${l.amount < 0n ? 'Cdtr' : 'Dbtr'}><Pty><Nm>${xml(l.payee)}</Nm></Pty></${l.amount < 0n ? 'Cdtr' : 'Dbtr'}></RltdPties>` +
      (l.category || l.glCode ? `<AddtlTxInf>${xml([l.category, l.glCode].filter(Boolean).join(' / '))}</AddtlTxInf>` : '') +
      `</TxDtls></NtryDtls></Ntry>`,
  );
  const id = `STMT-${s.accountId.slice(0, 8)}-${day(s.from)}`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">',
    '<BkToCstmrStmt>',
    `<GrpHdr><MsgId>${xml(id)}</MsgId><CreDtTm>${iso(s.generatedAt)}</CreDtTm></GrpHdr>`,
    `<Stmt><Id>${xml(id)}</Id><CreDtTm>${iso(s.generatedAt)}</CreDtTm>`,
    `<FrToDt><FrDtTm>${iso(s.from)}</FrDtTm><ToDtTm>${iso(lastDay(s))}</ToDtTm></FrToDt>`,
    `<Acct><Id><Othr><Id>${xml(s.accountId)}</Id></Othr></Id><Ccy>${xml(s.currency)}</Ccy><Nm>${xml(s.accountName)}</Nm>` +
      `<Svcr><FinInstnId><Nm>${xml(s.servicer)}</Nm></FinInstnId></Svcr></Acct>`,
    bal('OPBD', s.opening, s.from),
    bal('CLBD', s.closing, lastDay(s)),
    `<TxsSummry><TtlNtries><NbOfNtries>${s.lines.length}</NbOfNtries><Sum>${formatAmount(sum)}</Sum>` +
      `<TtlNetNtry><Amt>${formatAmount(abs(net))}</Amt>${ind(net)}</TtlNetNtry></TtlNtries></TxsSummry>`,
    ...entries,
    '</Stmt>',
    '</BkToCstmrStmt>',
    '</Document>',
    '',
  ].join('\n');
}

const qifText = (v: string) => v.replace(/[\r\n^]/g, ' ');
const qifDate = (d: Date) => `${day(d).slice(5, 7)}/${day(d).slice(8, 10)}/${day(d).slice(0, 4)}`;

/**
 * QIF, as Quicken reads a bank account: its first record is the opening balance, then one record per line with the line
 * id as its number. The closing balance is the opening plus every line, as QIF states it.
 */
export function bookQif(s: BookStatement): string {
  const out = ['!Type:Bank', `D${qifDate(s.from)}`, `T${formatAmount(s.opening)}`, 'POpening Balance', `L[${qifText(s.accountName)}]`, '^'];
  for (const l of s.lines) {
    out.push(`D${qifDate(l.bookedAt)}`, `T${formatAmount(l.amount)}`, `N${qifText(l.id)}`, `P${qifText(l.payee)}`);
    if (l.category) out.push(`L${qifText(l.category)}`);
    if (l.glCode) out.push(`MGL ${qifText(l.glCode)}`);
    out.push('^');
  }
  return `${out.join('\r\n')}\r\n`;
}
