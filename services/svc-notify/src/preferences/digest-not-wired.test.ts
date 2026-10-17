import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Topic choices, quiet hours, and summaries are product procedures.
 * Critical still ignores mute, topic choice, and quiet hours.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function source(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('topic and digest preferences are wired', () => {
  it('router exposes the preference, delivery-list, and notice procedures', () => {
    const router = source('router.ts');
    for (const name of [
      'topicPrefs:',
      'setTopicPref:',
      'digestPrefs:',
      'setDigest:',
      'recentDeliveries:',
      'notices:',
      'notice:',
      'noticeStatus:',
      'draftNotice:',
      'publishNotice:',
    ]) {
      expect(router).toContain(name);
    }
  });

  it('dispatch asks the preference gate and skips it for critical', () => {
    const dispatch = source('dispatch.ts');
    expect(dispatch).toContain('planOutOfApp');
    expect(dispatch).toContain("notification.severity !== 'critical'");
  });

  it('index constructs the preference stores and the notice board', () => {
    const index = source('index.ts');
    expect(index).toContain('PostgresTopicPrefStore');
    expect(index).toContain('PostgresHoldStore');
    expect(index).toContain('NoticeBoard');
    expect(index).toContain('planOutOfApp');
  });
});
