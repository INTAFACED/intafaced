import { describe, expect, it } from 'vitest';
import { parseSrt, parseVtt } from './tracks.js';

describe('parseVtt (AC-videos-01 caption tracks)', () => {
  it('reads cues with hours, identifiers, settings and a byte-order mark, skipping NOTE and STYLE, in start order', () => {
    const vtt =
      '﻿WEBVTT - TEST\r\n\r\nSTYLE\r\n::cue { color: red }\r\n\r\nb\r\n01:00:01.000 --> 01:00:02.000 line:0\r\nTEST later\r\ntwo lines\r\n\r\nNOTE skip me\r\n\r\n00:00.250 --> 00:01.000\r\nTEST first\r\n';
    expect(parseVtt(vtt)).toEqual([
      { startMs: 250, endMs: 1000, text: 'TEST first' },
      { startMs: 3_601_000, endMs: 3_602_000, text: 'TEST later\ntwo lines' },
    ]);
  });

  it('skips header lines such as Kind and Language up to the first blank line', () => {
    expect(parseVtt('WEBVTT\nKind: captions\nLanguage: en\n\n00:00.000 --> 00:01.000\nTEST <i>one</i>\n')).toEqual([
      { startMs: 0, endMs: 1000, text: 'TEST <i>one</i>' },
    ]);
  });

  it('an empty file with only the header has no cues', () => {
    expect(parseVtt('WEBVTT\n')).toEqual([]);
  });

  it.each([
    ['no header', 'TEST\n\n00:00.000 --> 00:01.000\nx'],
    ['a header that only starts like one', 'WEBVTTX\n'],
    ['a block with no timing', 'WEBVTT\n\nhello\nworld'],
    ['a bad timestamp', 'WEBVTT\n\n0:0.0 --> 00:01.000\nx'],
    ['an end before the start', 'WEBVTT\n\n00:01.000 --> 00:01.000\nx'],
    ['a cue with no blank line after the header', 'WEBVTT\n00:00.000 --> 00:01.000\nx'],
  ])('refuses %s with academy.captions_invalid', (_why, vtt) => {
    expect(() => parseVtt(vtt)).toThrow(expect.objectContaining({ code: 'academy.captions_invalid' }));
  });
});

describe('parseSrt (AC-videos-02)', () => {
  it('reads numbered cues with comma milliseconds, sorted, and names the first line that breaks the shape', () => {
    expect(parseSrt('﻿2\r\n00:00:05,000 --> 00:00:06,000\r\nB\r\n\r\n1\r\n00:00:01,000 --> 00:00:02,500\r\nA\r\nA2\r\n')).toEqual([
      { startMs: 1000, endMs: 2500, text: 'A\nA2' },
      { startMs: 5000, endMs: 6000, text: 'B' },
    ]);
    const why = (srt: string) => {
      try {
        parseSrt(srt);
        return null;
      } catch (error) {
        return (error as { code: string; message: string }).message;
      }
    };
    expect(why('1\n00:00:01,000 --> 00:00:02,000\nA\n\nx\n')).toContain('line 5: "x" is not a cue number');
    expect(why('1\n00:00:01.000 --> 00:00:02,000\nA\n')).toContain('line 2: "00:00:01.000" is not an SRT timestamp');
    expect(why('1\n00:00:03,000 --> 00:00:02,000\nA\n')).toContain('line 2: a cue ends before it starts');
    expect(why('1\n00:00:01,000 --> 00:00:02,000\n')).toContain('line 2: a cue has no text');
    expect(why('1\nno timing\n')).toContain('line 2: a cue has no timing line');
    expect(why('')).toContain('the file has no cues');
  });
});
