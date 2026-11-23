// DateInput: the native day box stays (keys, picker, form value, fill() in tests), and at rest it shows the
// day in the page's language, never the browser's mm/dd/yyyy.
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DateInput, DateOrInput, emptyDateValue, formatDateValue } from './date-input.js';
import { Field } from './index.js';
import { TextField } from './b2-fields.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const none = () => undefined;

describe('formatDateValue', () => {
  it('writes a day in the language asked for, its month by name, never an order of bare digits', () => {
    expect(formatDateValue('2026-11-23', 'date', 'en-GB')).toBe('23 Nov 2026');
    expect(formatDateValue('2026-11-23', 'date', 'en')).toBe('Nov 23, 2026');
    expect(formatDateValue('2026-11-23', 'date', 'de')).toBe('23. Nov. 2026');
    expect(formatDateValue('2026-11-23', 'date', 'fr')).toBe('23 nov. 2026');
    for (const locale of ['en', 'en-GB', 'de', 'fr', 'es', 'ar', 'ja']) {
      expect(formatDateValue('2026-11-23', 'date', locale)).not.toMatch(/\b11\/23\/2026\b/);
    }
  });

  it('never moves the day across a zone: the first and last day of a year stay themselves', () => {
    expect(formatDateValue('2026-01-01', 'date', 'en-GB')).toBe('1 Jan 2026');
    expect(formatDateValue('2026-12-31', 'date', 'en-GB')).toBe('31 Dec 2026');
  });

  it('writes a day and a time with the time as typed', () => {
    expect(formatDateValue('2026-11-23T14:05', 'datetime-local', 'en-GB')).toBe('23 Nov 2026, 14:05');
    expect(formatDateValue('2026-11-23T14:05:30', 'datetime-local', 'de')).toBe('23.11.2026, 14:05');
  });

  it('writes nothing for an empty, partial or impossible value', () => {
    expect(formatDateValue('', 'date', 'en')).toBe('');
    expect(formatDateValue('2026-02-30', 'date', 'en')).toBe('');
    expect(formatDateValue('2026-11', 'date', 'en')).toBe('');
    expect(formatDateValue('2026-11-23', 'datetime-local', 'en')).toBe('');
  });

  it('an unknown language falls back to the browser default rather than throwing', () => {
    expect(formatDateValue('2026-11-23', 'date', 'not a tag')).not.toBe('');
  });
});

describe('emptyDateValue', () => {
  it("names the parts in the order and form a chosen day is written in, never the browser's digits", () => {
    expect(emptyDateValue('date', 'en-GB')).toBe('day mo yr');
    expect(emptyDateValue('date', 'en')).toBe('mo day, yr');
    expect(emptyDateValue('datetime-local', 'en-GB')).toBe('day mo yr, hr:min');
    expect(emptyDateValue('date', 'ja')).toBe('年月日');
  });
});

describe('DateInput', () => {
  it('keeps the native box and its ISO value, and draws the day in the language beside it, hidden from the name', () => {
    const out = html(<DateInput id="d" aria-label="From" value="2026-11-23" onChange={none} locale="en-GB" />);
    expect(out).toContain('<span class="lit-date">');
    expect(out).toMatch(/<input id="d" aria-label="From" type="date" value="2026-11-23"\/>/);
    expect(out).toContain('<span data-part="shown" aria-hidden="true" data-shown="23 Nov 2026"></span>');
  });

  it('marks an empty box and shows its parts in order', () => {
    const out = html(<DateInput value="" onChange={none} locale="en-GB" />);
    expect(out).toContain('<span class="lit-date" data-empty="">');
    expect(out).toContain('data-shown="day mo yr"');
  });

  it('an uncontrolled box shows its starting value', () => {
    const out = html(<DateInput type="datetime-local" name="at" defaultValue="2026-11-23T09:30" locale="en-GB" />);
    expect(out).toContain('data-shown="23 Nov 2026, 09:30"');
    expect(out).toContain('name="at"');
  });

  it('the written day is no text node, so a wrapping label still reads as its own words', () => {
    const out = html(
      <label>
        <span>From date</span>
        <DateInput value="2026-11-23" onChange={none} locale="en-GB" />
      </label>,
    );
    expect(out.replace(/<[^>]+>/g, '')).toBe('From date');
  });
});

describe('every field draws a day through DateInput', () => {
  it('DateOrInput leaves any other box plain', () => {
    expect(html(<DateOrInput type="text" value="x" onChange={none} />)).toBe('<input type="text" value="x"/>');
    expect(html(<DateOrInput type="date" value="2026-11-23" onChange={none} />)).toContain('class="lit-date"');
  });

  it('the kit Field and TextField', () => {
    expect(html(<Field label="Day" type="date" value="2026-11-23" onChange={none} />)).toContain('class="lit-date"');
    expect(html(<Field label="Name" value="x" onChange={none} />)).not.toContain('lit-date');
    expect(html(<TextField label="At" type="datetime-local" value="2026-11-23T14:05" onChange={none} />)).toContain('class="lit-date"');
  });
});
