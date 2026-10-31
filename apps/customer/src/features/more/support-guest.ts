import {
  supportGuestCreateInputSchema,
  supportGuestCreateResultSchema,
  supportGuestReplyInputSchema,
  supportGuestReplyResultSchema,
  supportGuestThreadInputSchema,
  supportGuestThreadSchema,
  supportGuestVerifyInputSchema,
  supportGuestVerifyResultSchema,
} from '@intafaced/contracts/support-guest';
import { contractProcedure } from '../../shared/contract-call';

/** The guest path (SP-tickets-01): public calls, no session. Tokens go in the POST body, never in an address. */
export const guestCreate = contractProcedure('support', 'guestCreate', {
  input: supportGuestCreateInputSchema,
  output: supportGuestCreateResultSchema,
});
export const guestVerify = contractProcedure('support', 'guestVerify', {
  input: supportGuestVerifyInputSchema,
  output: supportGuestVerifyResultSchema,
});
export const guestThread = contractProcedure('support', 'guestThread', {
  input: supportGuestThreadInputSchema,
  output: supportGuestThreadSchema,
});
export const guestReply = contractProcedure('support', 'guestReply', {
  input: supportGuestReplyInputSchema,
  output: supportGuestReplyResultSchema,
});

/** The token a link carries after `#<name>=`, read once; the address bar keeps no token. */
export function takeLinkToken(name: 'token' | 'access'): string {
  const value = new URLSearchParams(location.hash.replace(/^#/, '')).get(name)?.trim() ?? '';
  if (location.hash) history.replaceState(history.state, '', location.pathname);
  return value;
}
