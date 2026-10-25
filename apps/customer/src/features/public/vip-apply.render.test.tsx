// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../../shared/api';
import type { Loadable } from '../../data/types';
import { VipApplyView } from './VipApply';
import {
  sizeName,
  toBase64,
  typeName,
  vipApplicationsSchema,
  vipRequestId,
  type VipApplication,
  type VipApplications,
} from './vip-application';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SP-fees-vip-04 / J-cex-spot-10 #7: the VIP application on My tier. TEST rules and files only, never owner values.
const RULES = { proofTypes: ['application/pdf', 'image/png'], maxBytes: 512 * 1024 };
const APPLICATION: VipApplication = {
  id: 'a1',
  requestId: 'proof-0011223344',
  status: 'pending',
  proof: { fileName: 'statement.pdf', contentType: 'application/pdf', byteLength: 2048, sha256: 'ab'.repeat(32) },
  note: null,
  scheduleVersion: 'v7',
  createdAt: '2026-10-25T01:00:00.000Z',
  updatedAt: '2026-10-25T01:00:00.000Z',
};
const ready = (data: VipApplications): Loadable<VipApplications> => ({ status: 'ready', data: vipApplicationsSchema.parse(data), asOf: 0 });
type Sent = ApiResult<{ application: VipApplication }>;
type Send = (file: File, note: string, after: string) => Promise<Sent>;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const view = (load: Loadable<VipApplications>, send: Send = vi.fn()) => act(() => root.render(<VipApplyView load={load} send={send} />));
const text = (selector: string) => host.querySelector(selector)?.textContent ?? null;

async function choose(file: File) {
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}
async function sendForm() {
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

describe('VIP application', () => {
  it('says applications are not open when the owner published no proof rules, with no form', () => {
    view(ready({ rules: null, closed: 'vip.application_unset', applications: [] }));
    expect(text('[data-vip=not-open]')).toBe('Applications are not open: no accepted proof file is published.');
    expect(host.querySelector('form')).toBeNull();
    expect(text('[data-vip=none]')).toBe('You have not applied.');
  });

  it('names the accepted files and the largest size, and offers the form', () => {
    view(ready({ rules: RULES, closed: null, applications: [] }));
    expect(text('[data-vip=rules]')).toBe('Accepted files: PDF, PNG, up to 512 KB.');
    expect(host.querySelector('input[type=file]')?.getAttribute('accept')).toBe('application/pdf,image/png');
    expect(host.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true);
  });

  it('a pending application hides the form and is listed waiting for review', () => {
    view(ready({ rules: RULES, closed: null, applications: [APPLICATION] }));
    expect(host.querySelector('form')).toBeNull();
    expect(text('[data-vip=waiting]')).toContain('waiting for review');
    expect(text('tr[data-vip-application=pending]')).toContain('statement.pdf (PDF, 2 KB)');
    expect(text('tr[data-vip-application=pending] td:last-child')).toBe('Waiting for review');
  });

  it('a refused type names the accepted files; a kept one says it is waiting', async () => {
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'error',
        code: 'vip.file_type_unsupported',
        message: 'text/plain is not an accepted proof file type',
      })
      .mockResolvedValueOnce({ ok: true, data: { application: APPLICATION } });
    view(ready({ rules: RULES, closed: null, applications: [] }), send);
    await choose(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    await sendForm();
    expect(text('[data-vip-result=refused]')).toBe('Not sent: text/plain is not an accepted file. Accepted: PDF, PNG.');
    await choose(new File(['%PDF-1.4'], 'statement.pdf', { type: 'application/pdf' }));
    await sendForm();
    expect(send).toHaveBeenCalledTimes(2);
    expect(text('[data-vip-result=sent]')).toBe('Application sent: statement.pdf is waiting for review.');
  });

  it('says the proof key is missing before anyone chooses a file', () => {
    view(ready({ rules: null, closed: 'vip.proof_key_unset', applications: [] }));
    expect(text('[data-vip=not-open]')).toBe('Applications are not open: no key to store proof files safely is set.');
    expect(host.querySelector('form')).toBeNull();
  });

  it('an answer that never came is not called a refusal, and a decided application sent again is named', async () => {
    const decided = { ...APPLICATION, id: 'a0', status: 'rejected' as const };
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce({ ok: false, reason: 'uncertain', message: 'timed out' })
      .mockResolvedValueOnce({ ok: true, data: { application: decided } });
    view(ready({ rules: RULES, closed: null, applications: [decided] }), send);
    await choose(new File(['%PDF-1.4'], 'statement.pdf', { type: 'application/pdf' }));
    await sendForm();
    expect(text('[data-vip-result=refused]')).toBe(
      'We could not confirm the application was kept. Your list below is refreshed; sending the same file again is safe.',
    );
    // The request names the newest application before it, so a new attempt after a decision is a new request.
    expect(send.mock.calls[0]![2]).toBe('a0');
    await sendForm();
    expect(text('[data-vip-result=refused]')).toBe('Not sent again: this is your earlier application, now "Not approved".');
  });

  it('a file over the published size is refused before it is read or sent', async () => {
    const send = vi.fn<Send>();
    view(ready({ rules: { ...RULES, maxBytes: 4 }, closed: null, applications: [] }), send);
    await choose(new File(['%PDF-1.4'], 'big.pdf', { type: 'application/pdf' }));
    await sendForm();
    expect(send).not.toHaveBeenCalled();
    expect(text('[data-vip-result=refused]')).toBe('Not sent: this file is over the 4 bytes limit.');
  });
});

describe('VIP application helpers', () => {
  it('names types and sizes as a person reads them, never rounding up past the limit', () => {
    expect(typeName('application/pdf')).toBe('PDF');
    expect(typeName('image/webp')).toBe('image/webp');
    expect(sizeName(5 * 1024 * 1024)).toBe('5 MB');
    expect(sizeName(1024 * 1024 - 1)).toBe('1023.9 KB');
    expect(sizeName(10)).toBe('10 bytes');
  });

  it('encodes canonical base64 across slices', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 3).map((_, i) => i % 251);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('the same file, name and note after the same application is the same request; anything else is another', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4 TEST');
    const once = await vipRequestId(bytes, 'statement.pdf', 'from venue X', 'none');
    expect(once).toMatch(/^proof-[0-9a-f]{40}$/);
    expect(await vipRequestId(bytes, 'statement.pdf', ' from venue X ', 'none')).toBe(once);
    expect(await vipRequestId(bytes, 'statement.pdf', 'another', 'none')).not.toBe(once);
    expect(await vipRequestId(bytes, 'renamed.pdf', 'from venue X', 'none')).not.toBe(once);
    expect(await vipRequestId(bytes, 'statement.pdf', 'from venue X', 'a1')).not.toBe(once);
  });
});
