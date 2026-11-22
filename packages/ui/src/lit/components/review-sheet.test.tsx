import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReviewSheet, type ReviewSheetProps } from './index.js';

const base: ReviewSheetProps = {
  label: 'Refund',
  reviewTitle: 'Review Refund',
  description: 'The refund goes back to the payer.',
  busyLabel: 'Waiting for confirmation',
  opened: false,
  onOpen: () => undefined,
  onClose: () => undefined,
  onConfirm: () => undefined,
};
const html = (props: Partial<ReviewSheetProps> = {}) => renderToStaticMarkup(<ReviewSheet {...base} {...props} />);

describe('ReviewSheet', () => {
  it('closed, draws only its button and the last answer', () => {
    const out = html({ outcome: <p role="status">Done</p> });
    expect(out).toContain('>Refund</button>');
    expect(out).toContain('<p role="status">Done</p>');
    expect(out).not.toContain('<dialog');
  });

  it('open, draws the review in the Sheet: description, body, note, answer, then the confirm', () => {
    const out = html({ opened: true, note: <p>Note</p>, outcome: <p>Answer</p>, children: <p>Body</p> });
    expect(out).toContain('<dialog class="lt-sheet" aria-label="Review Refund">');
    const stack = out.slice(out.indexOf('data-testid="form-stack"'));
    const order = ['The refund goes back to the payer.', 'Body', 'Note', 'Answer', '>Refund</button>'].map((s) => stack.indexOf(s));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('in flight, both buttons wait, the confirm says so and the sheet cannot be dismissed', () => {
    const out = html({ opened: true, busy: true });
    expect(out).toContain('>Waiting for confirmation</button>');
    expect(out.match(/<button[^>]*disabled=""/g)?.length).toBe(3);
  });

  it('an unknown answer blocks both buttons; a review not ready keeps only its confirm off and says why', () => {
    const blocked = html({ opened: true, blocked: true });
    expect(blocked.match(/<button[^>]*disabled=""[^>]*data-slot="button"/g)?.length).toBe(2);
    const notReady = html({ opened: true, ready: false, notReadyReason: 'Tick each line first.' });
    expect(notReady).toContain('<p class="lt-hint">Tick each line first.</p>');
    expect(notReady.match(/<button[^>]*disabled=""[^>]*data-slot="button"/g)?.length).toBe(1);
  });

  it('a disabled action names why on its row', () => {
    expect(html({ disabled: true, disabledReason: 'Only the owner can refund.' })).toContain('<div title="Only the owner can refund.">');
  });
});
