/**
 * Support agent L3 — pure ticket comment draft gate (Stage-2 write path).
 *
 * Builds a comment payload only when ticket id + body are real.
 * Never invents refund amounts, balance claims, or empty “helpful” replies.
 * Money-tool execution stays banned by guardrail; this only shapes text.
 */

export type CommentDraftOk = {
  readonly status: 'ok';
  readonly ticketId: string;
  readonly body: string;
};

export type CommentDraftRefuse = {
  readonly status: 'refuse';
  readonly reason: 'missing_ticket' | 'empty_body' | 'body_too_long' | 'money_invent_language';
  readonly userMessageKey: 'agents.support.comment_refused';
};

export type CommentDraftResult = CommentDraftOk | CommentDraftRefuse;

const MAX_BODY = 4_000;

/** Language that pretends to move value or invent balances — refuse. */
const MONEY_INVENT = /\b(i (have )?refunded|balance (is|now) \d+|credited \$?\d+|wired \$?\d+|sent you \$?\d+|payout of)\b/i;

/**
 * Pure draft for support.ticket.comment. Caller still needs guardrail approval.
 */
export function draftTicketComment(input: { ticketId: string | null | undefined; body: string | null | undefined }): CommentDraftResult {
  const ticketId = input.ticketId?.trim() ?? '';
  if (!ticketId) {
    return { status: 'refuse', reason: 'missing_ticket', userMessageKey: 'agents.support.comment_refused' };
  }
  const body = input.body?.trim() ?? '';
  if (body.length < 1) {
    return { status: 'refuse', reason: 'empty_body', userMessageKey: 'agents.support.comment_refused' };
  }
  if (body.length > MAX_BODY) {
    return { status: 'refuse', reason: 'body_too_long', userMessageKey: 'agents.support.comment_refused' };
  }
  if (MONEY_INVENT.test(body)) {
    return { status: 'refuse', reason: 'money_invent_language', userMessageKey: 'agents.support.comment_refused' };
  }
  return { status: 'ok', ticketId, body };
}

/** L3 — true when draft ok. */
export function isCommentDraftOk(result: CommentDraftResult): result is CommentDraftOk {
  return result.status === 'ok';
}

/** L3 — board card. */
export function commentDraftBoardCard(result: CommentDraftResult): {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly bodyLen: number;
} {
  if (result.status === 'ok') {
    return { ok: true, reason: null, bodyLen: result.body.length };
  }
  return { ok: false, reason: result.reason, bodyLen: 0 };
}

/** L3 — status line. */
export function commentDraftStatusLine(result: CommentDraftResult): string {
  const c = commentDraftBoardCard(result);
  return `ok=${c.ok ? '1' : '0'} bodyLen=${c.bodyLen} reason=${c.reason ?? '-'}`;
}

/** L3 — parse status. Invalid → null. */
export function parseCommentDraftStatusLine(
  line: string,
): { readonly ok: boolean; readonly bodyLen: number; readonly reason: string | null } | null {
  const m = line.trim().match(/^ok=([01]) bodyLen=(\d+) reason=(\S+)$/);
  if (!m) return null;
  return { ok: m[1] === '1', bodyLen: Number(m[2]), reason: m[3] === '-' ? null : m[3]! };
}

/** L3 — true when status matches. */
export function commentDraftStatusLineMatches(result: CommentDraftResult): boolean {
  const p = parseCommentDraftStatusLine(commentDraftStatusLine(result));
  if (!p) return false;
  const c = commentDraftBoardCard(result);
  return p.ok === c.ok && p.bodyLen === c.bodyLen && p.reason === c.reason;
}

/** L3 — export header. */
export function commentDraftExportHeader(): string {
  return 'status,bodyLen,reason';
}

/** L3 — export line. */
export function commentDraftExportLine(result: CommentDraftResult): string {
  const c = commentDraftBoardCard(result);
  return `${c.ok ? 'ok' : 'refuse'},${c.bodyLen},${c.reason ?? ''}`;
}

/** L3 — full export. */
export function commentDraftExportText(result: CommentDraftResult): string {
  return [commentDraftExportHeader(), commentDraftExportLine(result)].join('\n');
}
