import { describe, expect, it } from 'vitest';
import { academyFixture } from '../../../preview/fixtures/academy';

const { courses, lobbies, certs, topics, continueCourseId } = academyFixture.rows;

describe('academy fixture', () => {
  it('is sample data for academy, with a plain note', () => {
    expect(academyFixture.product).toBe('academy');
    expect(academyFixture.sample).toBe(true);
    expect(academyFixture.note.length).toBeGreaterThan(10);
  });

  it('has courses whose progress makes sense and whose topics exist', () => {
    expect(courses.length).toBeGreaterThanOrEqual(4);
    for (const course of courses) {
      expect(course.lessonsDone).toBeGreaterThanOrEqual(0);
      expect(course.lessonsDone).toBeLessThanOrEqual(course.lessons);
      expect(topics).toContain(course.topic);
    }
    expect(courses.some((c) => c.lessonsDone === c.lessons)).toBe(true);
    expect(courses.some((c) => c.lessonsDone > 0 && c.lessonsDone < c.lessons)).toBe(true);
    expect(courses.some((c) => c.id === continueCourseId && c.lessonsDone < c.lessons)).toBe(true);
  });

  it('has a live lobby and upcoming ones, never more people than seats', () => {
    expect(lobbies.some((l) => l.state === 'live')).toBe(true);
    expect(lobbies.some((l) => l.state === 'upcoming')).toBe(true);
    for (const lobby of lobbies) expect(lobby.taken).toBeLessThanOrEqual(lobby.seats);
  });

  it('has certificates that are earned, in progress and locked, with requirements', () => {
    for (const status of ['earned', 'in-progress', 'locked'] as const) expect(certs.some((c) => c.status === status)).toBe(true);
    for (const cert of certs) {
      expect(cert.requirements.length).toBeGreaterThan(0);
      if (cert.status === 'earned') expect(cert.requirements.every((r) => r.done)).toBe(true);
    }
  });

  it('carries no money and no returns language', () => {
    expect(JSON.stringify(academyFixture.rows)).not.toMatch(/\$|APY|yield|profit|guarantee/i);
  });
});
