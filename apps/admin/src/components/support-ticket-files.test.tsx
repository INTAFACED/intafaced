import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TicketFile } from '@/lib/support/files';
import type { TicketFilesView } from '@/lib/support/files-server';
import { TicketFilesPanelView, type TicketFilesViewProps } from './support-ticket-files';

const file = (over: Partial<TicketFile> = {}): TicketFile => ({
  id: '44444444-4444-4444-8444-444444444444',
  ticketId: '22222222-2222-4222-8222-222222222222',
  ownerId: '11111111-1111-4111-8111-111111111111',
  contentType: 'image/png',
  byteLength: 2048,
  scanState: 'clean',
  uploadedBy: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  ...over,
});
const view = (rows: TicketFile[]): TicketFilesView => ({
  asOf: '2026-10-20T11:00:00.000Z',
  files: { kind: 'ok', data: rows } as TicketFilesView['files'],
});
const base = (over: Partial<TicketFilesViewProps> = {}): TicketFilesViewProps => ({
  view: view([]),
  loading: false,
  busyId: null,
  refusal: null,
  uploading: false,
  onDownload: () => undefined,
  onUpload: () => undefined,
  onRefresh: () => undefined,
  ...over,
});
const html = (p: TicketFilesViewProps) => renderToStaticMarkup(<TicketFilesPanelView {...p} />);

describe('the files on a ticket', () => {
  it('says there are none rather than showing nothing', () => {
    expect(html(base())).toContain('data-testid="ticket-files-empty"');
  });
  it('offers a download for a clean file only, and says why the others have none', () => {
    const out = html(
      base({
        view: view([
          file(),
          file({ id: '55555555-5555-4555-8555-555555555555', scanState: 'scanning' }),
          file({ id: '66666666-6666-4666-8666-666666666666', scanState: 'blocked' }),
        ]),
      }),
    );
    expect(out.match(/>Download</g)).toHaveLength(1);
    expect(out).toContain('data-scan-state="scanning"');
    expect(out).toContain('The scan has not finished.');
    expect(out).toContain('The scan refused this file.');
    expect(out).toContain('2.0 KB');
  });
  it('turns the other downloads off while one is running', () => {
    const out = html(base({ view: view([file()]), busyId: file().id }));
    expect(out).toContain('Downloading…');
    expect(out).toContain('disabled');
  });
  it('shows a refusal in words, a failed read as a failure, and states there is no upload', () => {
    expect(html(base({ refusal: { title: 'No such file for you', body: 'b', next: 'n', code: null, changed: 'no' } }))).toContain(
      'No such file for you',
    );
    const failed = { asOf: '2026-10-20T11:00:00.000Z', files: { kind: 'failed', forbidden: true, message: 'denied', code: null } };
    expect(html(base({ view: failed as TicketFilesView }))).toContain('Files unavailable');
    expect(html(base({ view: null }))).toContain('could not be read');
  });
  it('offers the assigned operator a file control and says the customer sees what they add', () => {
    const out = html(base());
    expect(out).toContain('data-testid="ticket-files-input"');
    expect(out).toContain('The customer sees a file you add, like a comment.');
    expect(out).not.toContain('cannot attach a file');
    expect(out).not.toContain('disabled=""');
  });
  it('turns the control off and says so while a file is being added', () => {
    const out = html(base({ uploading: true }));
    expect(out).toContain('Adding and scanning the file…');
    expect(out).toMatch(/data-testid="ticket-files-input"[^>]*disabled/);
  });
  it('marks who added each file', () => {
    const op = '77777777-7777-4777-8777-777777777777';
    const out = html(base({ view: view([file(), file({ id: '55555555-5555-4555-8555-555555555555', uploadedBy: op })]) }));
    expect(out).toContain('>Customer<');
    expect(out).toContain('Support · 77777777');
  });
});
