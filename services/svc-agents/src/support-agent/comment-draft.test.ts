import { describe, expect, it } from 'vitest';
import {
  draftTicketComment,
  isCommentDraftOk,
  commentDraftBoardCard,
  commentDraftStatusLine,
  parseCommentDraftStatusLine,
  commentDraftStatusLineMatches,
  commentDraftExportHeader,
  commentDraftExportLine,
  commentDraftExportText,
} from './comment-draft.js';

describe('support agent L3 comment draft', () => {
  it('accepts a clean draft', () => {
    expect(draftTicketComment({ ticketId: 't-1', body: 'Please share the order id.' })).toEqual({
      status: 'ok',
      ticketId: 't-1',
      body: 'Please share the order id.',
    });
  });

  it('refuses missing ticket / empty body', () => {
    expect(draftTicketComment({ ticketId: '  ', body: 'hi' }).status).toBe('refuse');
    expect(draftTicketComment({ ticketId: 't-1', body: '   ' })).toMatchObject({
      status: 'refuse',
      reason: 'empty_body',
    });
  });

  it('refuses money-invent language', () => {
    const r = draftTicketComment({ ticketId: 't-1', body: 'I have refunded you already.' });
    expect(r).toMatchObject({ status: 'refuse', reason: 'money_invent_language' });
  });

  it('refuses a multi-digit balance claim', () => {
    expect(draftTicketComment({ ticketId: 't-1', body: 'balance is 50' })).toMatchObject({
      status: 'refuse',
      reason: 'money_invent_language',
    });
  });

  it('refuses a multi-digit credit claim', () => {
    expect(draftTicketComment({ ticketId: 't-1', body: 'credited $100' })).toMatchObject({
      status: 'refuse',
      reason: 'money_invent_language',
    });
  });

  it('refuses a one-digit balance claim', () => {
    expect(draftTicketComment({ ticketId: 't-1', body: 'balance is 5' })).toMatchObject({
      status: 'refuse',
      reason: 'money_invent_language',
    });
  });

  it('returns ok when the comment does not claim a refund, balance, credit, wire, or payout', () => {
    expect(draftTicketComment({ ticketId: 't-1', body: 'We are looking into your ticket.' })).toEqual({
      status: 'ok',
      ticketId: 't-1',
      body: 'We are looking into your ticket.',
    });
  });
});

describe('L3 wave50 comment-draft status/export', () => {
  it('ok and refuse status lines', () => {
    const ok = draftTicketComment({ ticketId: 't-1', body: 'Please share the order id.' });
    expect(isCommentDraftOk(ok)).toBe(true);
    expect(commentDraftBoardCard(ok).bodyLen).toBeGreaterThan(0);
    expect(commentDraftStatusLineMatches(ok)).toBe(true);
    expect(commentDraftExportText(ok).startsWith(commentDraftExportHeader())).toBe(true);
    expect(parseCommentDraftStatusLine('nope')).toBeNull();

    const bad = draftTicketComment({ ticketId: '', body: 'x' });
    expect(isCommentDraftOk(bad)).toBe(false);
    expect(commentDraftStatusLine(bad)).toContain('reason=missing_ticket');
    expect(commentDraftStatusLineMatches(bad)).toBe(true);
    expect(commentDraftExportLine(bad)).toContain('refuse');
  });
});
