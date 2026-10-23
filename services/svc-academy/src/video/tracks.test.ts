import { describe, expect, it } from 'vitest';
import { parseVtt } from './tracks.js';

describe('parseVtt (AC-videos-01 caption tracks)', () => {
  it('reads cues with hours, identifiers, settings and a byte-order mark, skipping NOTE and STYLE, in start order', () => {
    const vtt =
      '﻿WEBVTT - TEST\r\n\r\nSTYLE\r\n::cue { color: red }\r\n\r\nb\r\n01:00:01.000 --> 01:00:02.000 line:0\r\nTEST later\r\ntwo lines\r\n\r\nNOTE skip me\r\n\r\n00:00.250 --> 00:01.000\r\nTEST first\r\n';
    expect(parseVtt(vtt)).toEqual([
      { startMs: 250, endMs: 1000, text: 'TEST first' },
      { startMs: 3_601_000, endMs: 3_602_000, text: 'TEST later\ntwo lines' },
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
  ])('refuses %s with academy.captions_invalid', (_why, vtt) => {
    expect(() => parseVtt(vtt)).toThrow(expect.objectContaining({ code: 'academy.captions_invalid' }));
  });
});
