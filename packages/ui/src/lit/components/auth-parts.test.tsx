import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChoiceTile, RadioTrack, WalletCard } from '../index.js';

const html = (n: React.ReactElement) => renderToStaticMarkup(n);

describe('sign-up parts', () => {
  it('draws a choice tile as a native radio named by its words', () => {
    const out = html(<ChoiceTile name="accountType" value="individual" checked readOnly title="Personal" detail="In your own name" />);
    expect(out).toMatch(/^<label class="lt-choice-tile"><input [^>]*type="radio"/);
    expect(out).toContain('name="accountType"');
    expect(out).toContain('checked=""');
    expect(out).toContain('<span class="lt-choice-tile__title">Personal</span>');
    expect(out).toContain('In your own name');
  });

  it('draws a radio track as native radios that keep their exact names and start unanswered', () => {
    const out = html(
      <RadioTrack
        name="usPerson"
        options={[
          { value: 'yes', label: 'Yes, I am a US person' },
          { value: 'no', label: 'No, I am not a US person' },
        ]}
      />,
    );
    expect(out.match(/type="radio"/g)).toHaveLength(2);
    expect(out).not.toContain('checked');
    expect(out).toContain('<span>Yes, I am a US person</span>');
    expect(out).toContain('<span>No, I am not a US person</span>');
  });

  it('checks the controlled answer only', () => {
    const out = html(
      <RadioTrack
        name="channel"
        value="email"
        options={[
          { value: 'email', label: 'Email' },
          { value: 'phone', label: 'Phone' },
        ]}
      />,
    );
    expect(out.match(/checked=""/g)).toHaveLength(1);
    expect(out).toMatch(/<input [^>]*value="email"[^>]*checked=""|<input [^>]*checked=""[^>]*value="email"/);
  });

  it('draws the wallet card with only what it is given', () => {
    const out = html(<WalletCard mark="INTAFACED" label="Your wallet" value="Made after the code" />);
    expect(out).toContain('lt-wallet-card__label">Your wallet</span>');
    expect(out).toContain('lt-wallet-card__value">Made after the code</span>');
  });
});
