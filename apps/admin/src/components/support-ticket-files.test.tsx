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
  onDownload: () => undefined,
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
    expect(html(base())).toContain('The desk cannot attach a file to a ticket.');
    expect(html(base({ view: null }))).toContain('could not be read');
  });
});
