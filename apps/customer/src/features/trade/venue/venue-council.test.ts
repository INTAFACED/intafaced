import { describe, expect, it } from 'vitest';
import { preparedStep, type KeptSignature, type PreparedAnswer } from '../venue-api';
import { keepsDraft, type ActionResult } from './VenueKit';
import { builderApprovalLine } from './VenueReview';
import { venueCopy } from './venue-copy';
import { spotGateChoice } from '../../../screens/trade/desk/VenueSpotDesk';
import { futuresVenueCopy } from '../../../screens/trade/futures/venue-copy';

// The council's round on the venue desks: an answer that is not definite is read back and never re-sent; a definite
// answer frees the draft id; the spot page never shows today's desk for a venue that is down; honest copy.

const KEPT: KeptSignature = { digest: `0x${'ab'.repeat(32)}`, signature: '0x01', signedBy: '0x00000000000000000000000000000000000000aa' };
const asOf = '2026-11-08T22:00:00.000Z';
const accepted = { definite: true, accepted: true, venueRef: null, order: null, asOf } as const;
const notDefinite = { definite: false, reason: 'timeout' } as const;
type Answer = Pick<PreparedAnswer, 'signed' | 'reused' | 'lastOutcome'>;
const local = (over: Partial<Parameters<typeof preparedStep>[1]> = {}) => ({
  kept: KEPT,
  refusedBeforeSend: false,
  promptedHere: true,
  ...over,
});

describe('one press after another on a venue action', () => {
  it('reads back a signed action with no definite answer and never sends it again, even with its bytes kept here', () => {
    const answer: Answer = { signed: true, reused: true, lastOutcome: notDefinite };
    expect(preparedStep(answer, local())).toEqual({ step: 'unknown' });
    // Signed, nothing recorded yet, and this page's own submit was not refused before it was sent: it may be live.
    expect(preparedStep({ signed: true, reused: true, lastOutcome: null }, local())).toEqual({ step: 'unknown' });
    expect(preparedStep({ signed: true, reused: true, lastOutcome: null }, local({ kept: undefined }))).toEqual({ step: 'unknown' });
  });

  it('re-sends the same bytes only after this page’s submit was refused definitely before it was sent', () => {
    expect(preparedStep({ signed: true, reused: true, lastOutcome: null }, local({ refusedBeforeSend: true }))).toEqual({
      step: 'resend',
      signature: KEPT,
    });
    // A refusal before send never re-sends over a not-definite answer the venue recorded.
    expect(preparedStep({ signed: true, reused: true, lastOutcome: notDefinite }, local({ refusedBeforeSend: true }))).toEqual({
      step: 'unknown',
    });
  });

  it('stands on the first definite answer', () => {
    expect(preparedStep({ signed: true, reused: true, lastOutcome: accepted }, local({ refusedBeforeSend: true }))).toEqual({
      step: 'outcome',
      outcome: accepted,
    });
  });

  it('waits for another tab’s prompt instead of prompting, and prompts on a fresh action or a second press here', () => {
    expect(preparedStep({ signed: false, reused: true, lastOutcome: null }, local({ promptedHere: false }))).toEqual({ step: 'wait' });
    expect(preparedStep({ signed: false, reused: true, lastOutcome: null }, local({ promptedHere: true }))).toEqual({ step: 'sign' });
    expect(preparedStep({ signed: false, reused: false, lastOutcome: null }, local({ promptedHere: false }))).toEqual({ step: 'sign' });
    expect(venueCopy.forLocale('en').t('Outcome waiting')).toMatch(/^Waiting for the other prompt/);
  });

  it('holds a draft id until a definite answer, then the next press is a new action', () => {
    const outcome: ActionResult = { kind: 'outcome', outcome: accepted, reused: false, clientOrderId: 'c1', nonce: '1' };
    const refusedOnVenue: ActionResult = {
      kind: 'outcome',
      outcome: { definite: true, accepted: false, refusal: { venueId: 'v', code: 'ioc_unfilled', detail: 'IOC' }, asOf },
      reused: false,
      clientOrderId: 'c1',
      nonce: '1',
    };
    expect(keepsDraft(outcome)).toBe(false);
    expect(keepsDraft(refusedOnVenue)).toBe(false);
    expect(keepsDraft({ kind: 'unknown', clientOrderId: 'c1', nonce: '1' })).toBe(true);
    expect(keepsDraft({ kind: 'rejected' })).toBe(true);
    expect(keepsDraft({ kind: 'waiting' })).toBe(true);
  });
});

describe('the spot page in venue mode', () => {
  it('shows today’s desk only while reading or for a pair the venue does not list; a venue that is down gets its notice', () => {
    expect(spotGateChoice(true, { status: 'loading' })).toBe('today');
    expect(spotGateChoice(true, { status: 'ready', listed: false })).toBe('today');
    expect(spotGateChoice(true, { status: 'ready', listed: true })).toBe('venue');
    expect(spotGateChoice(true, { status: 'failed' })).toBe('down');
    expect(spotGateChoice(false, { status: 'loading' })).toBe('down');
  });
});

describe('honest venue words', () => {
  const { t } = venueCopy.forLocale('en');
  it('a read-back that finds nothing so far says so and claims nothing was placed only from a definite answer', () => {
    expect(t('Read back missing')).toContain('not found so far');
    expect(t('Read back missing')).not.toContain('nothing was placed');
  });

  it('names a blank builder fee as the blank owner value, not only "not known"', () => {
    expect(builderApprovalLine(false, null)).toBe('Builder fee owner blank');
    expect(t('Builder fee owner blank')).toMatch(/owner value that is blank/);
    expect(builderApprovalLine(true, null)).toBe('Not known');
    expect(builderApprovalLine(true, true)).toBe('Builder approved');
  });

  it('labels the venue’s lot size as the lot size', () => {
    const f = futuresVenueCopy.forLocale('en').t;
    expect(f('Lot size')).toBe('Lot size');
  });
});
