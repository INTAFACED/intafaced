import { describe, expect, it } from 'vitest';
import { fileSizeLabel, readAttachment } from './support-attach';

describe('reading a file to attach', () => {
  it('turns the bytes into base64 and keeps the type the browser reported', async () => {
    const read = await readAttachment(new Blob([new Uint8Array([104, 105, 33])], { type: 'image/png' }));
    expect(read).toEqual({ ok: true, contentType: 'image/png', bodyBase64: 'aGkh', byteLength: 3 });
  });

  it('refuses a file too big to pass the gateway without reading it', async () => {
    const huge = {
      size: 24 * 1024 * 1024 + 1,
      type: 'video/mp4',
      arrayBuffer: () => Promise.reject(new Error('must not read')),
    } as unknown as Blob;
    expect(await readAttachment(huge)).toEqual({ ok: false, reason: 'tooLarge' });
  });

  it('falls back to a generic type when the browser reports none', async () => {
    const read = await readAttachment(new Blob(['x']));
    expect(read).toMatchObject({ ok: true, contentType: 'application/octet-stream' });
  });

  it('encodes a file larger than one chunk without losing a byte', async () => {
    const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, index) => index % 251);
    const read = await readAttachment(new Blob([bytes], { type: 'application/pdf' }));
    expect(read.ok).toBe(true);
    if (read.ok) expect(Uint8Array.from(Buffer.from(read.bodyBase64, 'base64'))).toEqual(bytes);
  });

  it('refuses an empty file before sending anything', async () => {
    expect(await readAttachment(new Blob([]))).toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses a file the browser cannot read', async () => {
    const broken = { size: 4, type: 'text/plain', arrayBuffer: () => Promise.reject(new Error('gone')) } as unknown as Blob;
    expect(await readAttachment(broken)).toEqual({ ok: false, reason: 'unreadable' });
  });
});

describe('file size label', () => {
  it('reads in the unit a person expects', () => {
    expect(fileSizeLabel(12)).toBe('12 bytes');
    expect(fileSizeLabel(2048)).toBe('2 KB');
    expect(fileSizeLabel(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
});
