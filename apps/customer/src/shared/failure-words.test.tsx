import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store; read the stored preferences once.
vi.mock('./preferences', async (original) => {
  const real = await original<typeof import('./preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import {
  canTryAgain,
  embeddedKey,
  failureRawCode,
  RAW_CODE,
  useFailureWords,
  type FailureNoteWords,
  type FailureWords,
} from './failure-words';
import { canTryAgain as uiCanTryAgain } from './ui';
import type { ApiResult } from './api';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
const refusal = (over: Partial<Refusal>): Refusal => ({ ok: false, reason: 'error', message: 'No earn rates are configured', ...over });

/** Both shapes of the words for one failure, read through the hook the way a room does. */
function wordsFor(result: Refusal, canRetry = true): { words: FailureWords; note: FailureNoteWords } {
  let words: FailureWords | undefined;
  let note: FailureNoteWords | undefined;
  function Probe() {
    words = useFailureWords(result, canRetry);
    note = useFailureWords()(result);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!words || !note) throw new Error('the hook did not answer');
  return { words, note };
}

describe('the retry rule is one rule, shared with the old kit', () => {
  it('is the same function the old Failure reads', () => {
    expect(uiCanTryAgain).toBe(canTryAgain);
  });
  it('offers Try again for trouble that can clear and never for a missing setting, an unknown outcome or sign-in', () => {
    expect(canTryAgain(refusal({ reason: 'unreachable' }))).toBe(true);
    expect(canTryAgain(refusal({ reason: 'error', code: 'edge.upstream_unavailable' }))).toBe(true);
    expect(canTryAgain(refusal({ code: 'bank.earn_rate_unset' }))).toBe(false);
    expect(canTryAgain(refusal({ reason: 'uncertain' }))).toBe(false);
    expect(canTryAgain(refusal({ reason: 'unauthorized' }))).toBe(false);
    expect(canTryAgain(refusal({ reason: 'unreachable', code: 'edge.upstream_unwired' }))).toBe(false);
  });
  it('puts the try-again word in the words only when the rule allows it and the caller can retry', () => {
    const down = refusal({ reason: 'unreachable', message: 'The service could not be reached.' });
    expect(wordsFor(down).words.retry).toBe('Try again');
    expect(wordsFor(down, false).words.retry).toBeUndefined();
    expect(wordsFor(down).note).toMatchObject({ retry: true, retryLabel: 'Try again', role: 'status' });
    const unset = wordsFor(refusal({ code: 'bank.earn_rate_unset' }));
    expect(unset.words.retry).toBeUndefined();
    expect(unset.note.retry).toBe(false);
  });
});

describe('a raw refusal code is never read by a customer', () => {
  it('finds a code that is the whole message, or a setting name inside a sentence', () => {
    expect(RAW_CODE.test('token.params_missing')).toBe(true);
    expect(failureRawCode(refusal({ message: ' token.params_missing ' }))).toBe('token.params_missing');
    expect(embeddedKey('Missing token_params.fee_discount_schedule')).toBe('token_params.fee_discount_schedule');
    expect(failureRawCode(refusal({ message: 'Missing token_params.fee_discount_schedule', code: 'token.params_missing' }))).toBe(
      'token_params.fee_discount_schedule',
    );
  });
  it('leaves ordinary words alone', () => {
    expect(failureRawCode(refusal({ message: 'Upload id_card.png failed' }))).toBeUndefined();
    expect(failureRawCode(refusal({ message: 'Version 1.2 is not available', code: 'x.y' }))).toBeUndefined();
    expect(embeddedKey('see e.g. v1.2')).toBeUndefined();
  });
  it('words a raw code as the refusal it names, with no button for a missing setting', () => {
    const { words, note } = wordsFor(refusal({ message: 'token.params_missing', code: 'token.params_missing' }));
    expect(words.title).toBe('Not switched on');
    expect(JSON.stringify(words)).not.toContain('token.params_missing');
    expect(words.retry).toBeUndefined();
    expect(note.title).toBe('Not switched on');
  });
});

describe('a write whose outcome is unknown never reads "refused"', () => {
  for (const [name, result] of [
    ['with a raw code', refusal({ reason: 'uncertain', message: 'trade.matching_unavailable', code: 'trade.matching_unavailable' })],
    ['in plain words', refusal({ reason: 'uncertain', message: 'The gateway timed out.' })],
  ] as const) {
    it(name, () => {
      const { words, note } = wordsFor(result);
      expect(words.title).toBe('Outcome not confirmed');
      expect(words.alert).toBe(true);
      expect(note.role).toBe('alert');
      for (const said of [words, note]) {
        expect(JSON.stringify(said)).not.toMatch(/refused|nothing was changed|isn.t trading|paused|trade\.matching/i);
        expect(said.action).toBeUndefined();
      }
      expect(words.retry).toBeUndefined();
      expect(note.retry).toBe(false);
    });
  }
});

describe('the rest of the old Failure, in words', () => {
  it('says a service the gateway reports as unwired is not connected here, with no button', () => {
    const { words, note } = wordsFor(refusal({ reason: 'unreachable', code: 'edge.upstream_unwired', message: 'upstream unwired (502)' }));
    expect(words).toEqual({ alert: false, title: 'This service is not connected', body: 'This service isn’t connected here.' });
    expect(note.retry).toBe(false);
  });
  it('offers sign-in, not Try again, when sign-in is needed', () => {
    vi.stubGlobal('location', { pathname: '/money', search: '?tab=earn' });
    try {
      const { words, note } = wordsFor(refusal({ reason: 'unauthorized', message: 'Sign in first' }));
      expect(words.action).toEqual({ label: 'Sign in', href: '/login?redirect=%2Fmoney%3Ftab%3Dearn' });
      expect(words.retry).toBeUndefined();
      expect(note.action).toEqual(words.action);
      expect(note.retry).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
