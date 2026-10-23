import { describe, expect, it } from 'vitest';
import { parseRestoreArchiveManifest, probeRestoreArchive } from './archive-probe.js';

const one = {
  id: 'full-9',
  kind: 'full',
  sequence: '9',
  takenAt: '2026-10-20T12:00:00.000Z',
};

function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe('restore archive manifest', () => {
  it('accepts full and incremental rows and an empty list', () => {
    expect(parseRestoreArchiveManifest({ backups: [one, { ...one, id: 'inc-10', kind: 'incremental', sequence: '10' }] })).toEqual([
      one,
      { id: 'inc-10', kind: 'incremental', sequence: '10', takenAt: one.takenAt },
    ]);
    expect(parseRestoreArchiveManifest({ backups: [] })).toEqual([]);
  });

  it('refuses a number, a blank, a duplicate, or a cut-off list instead of inventing rows', () => {
    expect(parseRestoreArchiveManifest({ backups: [{ ...one, sequence: 9 }] })).toBeNull();
    expect(parseRestoreArchiveManifest({ backups: [{ ...one, sequence: '' }] })).toBeNull();
    expect(parseRestoreArchiveManifest({ backups: [{ ...one, id: '  ' }] })).toBeNull();
    expect(parseRestoreArchiveManifest({ backups: [one, one] })).toBeNull();
    expect(parseRestoreArchiveManifest({ backups: [{ ...one, takenAt: 'yesterday' }] })).toBeNull();
    expect(parseRestoreArchiveManifest({ backups: null })).toBeNull();
  });
});

describe('probeRestoreArchive', () => {
  it('lists the manifest the archive returned', async () => {
    const result = await probeRestoreArchive('https://archive.example/restore', async () =>
      response(200, JSON.stringify({ backups: [one] }), { 'content-type': 'application/json' }),
    );
    expect(result).toEqual({ probed: true, backups: [one] });
  });

  it('stays unprobed when the archive does not answer, redirects, or is not a manifest', async () => {
    expect(await probeRestoreArchive('https://archive.example/restore', async () => response(503, ''))).toEqual({ probed: false });
    expect(
      await probeRestoreArchive('https://archive.example/restore', async () => {
        throw new Error('redirect');
      }),
    ).toEqual({ probed: false });
    expect(await probeRestoreArchive('file:///tmp/backups.json', async () => response(200, '{}'))).toEqual({ probed: false });
    expect(await probeRestoreArchive('https://archive.example/restore', async () => response(200, '{'))).toEqual({ probed: false });
    expect(
      await probeRestoreArchive('https://archive.example/restore', async () =>
        response(200, JSON.stringify({ backups: [{ sequence: 1 }] })),
      ),
    ).toEqual({ probed: false });
  });
});
