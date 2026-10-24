import { describe, expect, it } from 'vitest';
import {
  academyProgrammeCertId,
  academyProgrammeSchema,
  academyProgrammesInputSchema,
  academySaveProgrammeInputSchema,
} from './academy-programmes.js';

const save = {
  slug: 'trader-path',
  title: 'Trader path',
  summary: '',
  courseSlugs: ['markets', 'builder'],
  expectedRevision: null,
  reason: 'a programme',
};

describe('academy programmes (AC-programmes-01)', () => {
  it('a save names published learning-path courses once each, with a reason and an address of at most 48 characters', () => {
    expect(academySaveProgrammeInputSchema.safeParse(save).success).toBe(true);
    for (const bad of [
      { ...save, courseSlugs: ['markets', 'markets'] },
      { ...save, courseSlugs: ['a-course-staff-made'] },
      { ...save, slug: 'x'.repeat(49) },
      { ...save, slug: 'Trader Path' },
      { ...save, reason: ' ' },
      { ...save, extra: true },
    ])
      expect(academySaveProgrammeInputSchema.safeParse(bad).success).toBe(false);
  });

  it('a programme certificate id fits a certificate id, and a list read needs a limit', () => {
    expect(academyProgrammeCertId('x'.repeat(48)).length).toBeLessThanOrEqual(64);
    expect(academyProgrammesInputSchema.safeParse({}).success).toBe(false);
    expect(academyProgrammesInputSchema.safeParse({ limit: 201 }).success).toBe(false);
  });

  it('a read carries the three counts and an earned certificate with its serial', () => {
    const read = academyProgrammeSchema.parse({
      slug: 'trader-path',
      title: 'Trader path',
      summary: '',
      courses: [{ slug: 'markets', state: 'completed', items: 6, completed: 6 }],
      counts: { completed: 1, enrolled: 0, notEnrolled: 0 },
      certificate: {
        state: 'earned',
        certId: 'programme:trader-path',
        publicId: 'a'.repeat(32),
        grantedAt: '2026-10-24T12:00:00.000Z',
        status: 'valid',
      },
    });
    expect(read.certificate.state === 'earned' && read.certificate.grantedAt).toBeInstanceOf(Date);
  });
});
