/**
 * Identity consume for publishing a notice. Blank IDENTITY_URL or
 * INTERNAL_SERVICE_SECRET leaves this unwired; publish then refuses
 * `notify.notice_publish_approval_unavailable` rather than inventing a second person.
 */

import {
  createIdentityApprovalClient,
  type ActionApproval,
  type ActionApprovalConsumeInput,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import type { NoticeApprovalConsumer } from './board.js';

type S2sKey = { signer: ServiceSigner; mode: ServiceAuthMode };

export function noticeApprovalConsumerFromProcessEnv(s2s?: S2sKey): NoticeApprovalConsumer | null {
  const url = process.env.IDENTITY_URL?.trim() ?? '';
  const secret = process.env.INTERNAL_SERVICE_SECRET?.trim() ?? '';
  if (!url || secret.length < 32) return null;
  try {
    void new URL(url);
  } catch {
    return null;
  }
  return createNoticeApprovalClient(url, secret, s2s);
}

/** The shared identity approval client: one bounded call, key-signed once svc-notify has a key, CONSUMED echo checked. */
export function createNoticeApprovalClient(baseUrl: string, internalSecret: string, s2s?: S2sKey): NoticeApprovalConsumer {
  const client = createIdentityApprovalClient({
    service: 'svc-notify',
    baseUrl,
    internalSecret,
    fail: (message) => new Error(message),
    s2s,
  });
  return {
    consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      return client.consume(input);
    },
  };
}
