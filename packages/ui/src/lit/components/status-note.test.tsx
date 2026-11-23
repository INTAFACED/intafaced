// StatusNote: where something stands, polite unless it failed.
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusNote } from './status-note.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('StatusNote', () => {
  it('is a polite status by default: title, words, then the caller’s actions', () => {
    const out = html(
      <StatusNote title="Still confirming" actions={<a href="/money/activity">View activity</a>}>
        We will show the result here.
      </StatusNote>,
    );
    expect(out).toBe(
      '<div class="lit-note" data-tone="neutral" role="status"><p data-part="title">Still confirming</p><div data-part="body">We will show the result here.</div><div data-part="actions"><a href="/money/activity">View activity</a></div></div>',
    );
  });

  it('a warning stays polite; a failure is an alert', () => {
    expect(html(<StatusNote tone="warn">Held for review</StatusNote>)).toContain('data-tone="warn" role="status"');
    expect(html(<StatusNote tone="error">Could not load</StatusNote>)).toContain('data-tone="error" role="alert"');
  });

  it('draws only the parts it is given, and carries a test id', () => {
    const out = html(<StatusNote data-testid="pay-held">Held</StatusNote>);
    expect(out).toContain('data-testid="pay-held"');
    expect(out).not.toContain('data-part="title"');
    expect(out).not.toContain('data-part="actions"');
  });
});
