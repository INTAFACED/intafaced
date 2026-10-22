import { isExplicitDevOrTest } from '@intafaced/config';
import { MemoryAttachmentStore, type AttachmentStore, type MalwareScanner, type ScanVerdict } from './attachments.js';

/**
 * LOCAL-TEST adapters for the attachment desk, so a journey on the test stack can attach a file in the real app.
 * Production boots with neither: both are refused unless APP_ENV is exactly `dev` or `test`, and each is named in its
 * setting so no one mistakes it for a real store or a real scanner.
 *
 * - `local-test-memory` keeps bytes in this process and loses them on restart. It is not durable storage.
 * - `local-test-eicar` calls a file infected only when it carries the industry-standard EICAR test string, and clean
 *   otherwise. It cannot find real malware and says nothing about a real file's safety.
 */

export const LOCAL_TEST_STORE = 'local-test-memory';
export const LOCAL_TEST_SCANNER = 'local-test-eicar';
export const ATTACHMENT_ADAPTER_REFUSED = 'support.attachment_adapter_refused';

// Joined at run time so this file is not itself taken for a virus by a file scanner.
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE', '!$H+H*'].join('');

export class LocalTestEicarScanner implements MalwareScanner {
  async scan(bytes: Uint8Array): Promise<ScanVerdict> {
    return Buffer.from(bytes).toString('latin1').includes(EICAR) ? 'infected' : 'clean';
  }
}

export type LocalTestAttachmentBoot = {
  readonly appEnv: string | undefined;
  readonly store: string | undefined;
  readonly scanner: string | undefined;
};

/** Blank settings install nothing. A named adapter outside dev and test, or one this build does not have, throws. */
export function openLocalTestAttachments(input: LocalTestAttachmentBoot): {
  store: AttachmentStore | null;
  scanner: MalwareScanner | null;
} {
  const store = input.store?.trim() ?? '';
  const scanner = input.scanner?.trim() ?? '';
  if (store === '' && scanner === '') return { store: null, scanner: null };
  if (store !== '' && store !== LOCAL_TEST_STORE) {
    throw new Error(`${ATTACHMENT_ADAPTER_REFUSED}: SUPPORT_ATTACHMENT_STORE is not available`);
  }
  if (scanner !== '' && scanner !== LOCAL_TEST_SCANNER) {
    throw new Error(`${ATTACHMENT_ADAPTER_REFUSED}: SUPPORT_MALWARE_SCANNER is not available`);
  }
  if (!isExplicitDevOrTest(input.appEnv)) {
    throw new Error(`${ATTACHMENT_ADAPTER_REFUSED}: the local test adapters are allowed only when APP_ENV is exactly dev or test`);
  }
  return {
    store: store === LOCAL_TEST_STORE ? new MemoryAttachmentStore() : null,
    scanner: scanner === LOCAL_TEST_SCANNER ? new LocalTestEicarScanner() : null,
  };
}

export { EICAR as LOCAL_TEST_EICAR_STRING };
