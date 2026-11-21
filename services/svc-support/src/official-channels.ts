import { officialChannelListSchema, type OfficialChannelList } from '@intafaced/contracts';
import { SUPPORT_OFFICIAL_CHANNELS } from '@intafaced/contracts/support-official-channels-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { supportRefusal } from './record-refusal.js';

/**
 * The owner's official channel list from `SUPPORT_OFFICIAL_CHANNELS` (I-signin-sessions-26, J-identity-13 #1). Blank is
 * null (unpublished). A value that is not a valid list throws, so the service refuses to start rather than publish a
 * wrong list.
 */
export function officialChannelsFromEnv(raw: string | undefined): OfficialChannelList | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('SUPPORT_OFFICIAL_CHANNELS is not JSON');
  }
  const list = officialChannelListSchema.safeParse(parsed);
  if (!list.success) throw new Error(`SUPPORT_OFFICIAL_CHANNELS is not a valid list: ${list.error.issues[0]?.message ?? 'invalid'}`);
  return list.data;
}

/** `officialChannels` (public): the published list, or `{ published: false }`. */
export function officialChannelProcedures(list: OfficialChannelList | null) {
  return {
    officialChannels: mountRecord(
      SUPPORT_OFFICIAL_CHANNELS,
      () => (list ? { published: true as const, ...list } : { published: false as const }),
      supportRefusal,
    ),
  };
}
