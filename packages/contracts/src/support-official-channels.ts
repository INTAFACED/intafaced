import { z } from 'zod';

/**
 * The owner's official channel list (I-signin-sessions-26, J-identity-13 #1): the domains and sender addresses that are
 * really ours, and the support channels. svc-support serves it from its owner setting `SUPPORT_OFFICIAL_CHANNELS`
 * (`support.officialChannels`, public). Blank is unpublished: the page says so and checks nothing. A labelled TEST list
 * (`test: true`) stands in on test stacks only.
 *
 * `checkOfficialChannel` is the page's check, run in the browser with no network call. It only says whether what was
 * typed is on the published list exactly; it never calls anything safe.
 */
const domain = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'a lower-case domain name');

export const officialChannelListSchema = z
  .object({
    test: z.boolean().default(false),
    domains: z.array(domain).min(1).max(50),
    senders: z.array(z.string().email().max(320)).max(50).default([]),
    channels: z
      .array(z.object({ label: z.string().min(1).max(80), url: z.string().url().max(500) }).strict())
      .max(20)
      .default([]),
  })
  .strict();
export type OfficialChannelList = z.infer<typeof officialChannelListSchema>;

export const officialChannelsAnswerSchema = z.discriminatedUnion('published', [
  z.object({ published: z.literal(false) }),
  officialChannelListSchema.extend({ published: z.literal(true) }),
]);
export type OfficialChannelsAnswer = z.infer<typeof officialChannelsAnswerSchema>;

/** What the person typed, as the list compares it: lower case, no scheme, path, port or trailing dot. */
export function normaliseChannel(value: string): string {
  let text = value.trim().toLowerCase();
  if (text.includes('@')) return text;
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  text = text.split(/[/?#]/, 1)[0] ?? '';
  text = text.replace(/:\d+$/, '').replace(/\.+$/, '');
  return text;
}

/** `official` only for an exact match on the published list; anything else, a lookalike included, is `not_listed`. */
export function checkOfficialChannel(list: OfficialChannelList, value: string): { verdict: 'official' | 'not_listed'; shown: string } {
  const shown = normaliseChannel(value);
  const listed = shown.includes('@') ? list.senders.map((s) => s.toLowerCase()) : list.domains;
  return { verdict: listed.includes(shown) ? 'official' : 'not_listed', shown };
}
