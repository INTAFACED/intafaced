import { accountCopy } from './copy';

/** Names the service uses for changes INTAFACED or the system made. They are shown as "INTAFACED"; a person behind one is never named. */
const OPERATOR_IDS = new Set(['intafaced', 'system', 'operator', 'founder', 'admin:compliance']);

/**
 * Who did it, in words: "You", the label the team gave them, "INTAFACED" for operator and system changes, or "A team
 * member" when the name is not known to this role. A raw user id is never shown.
 */
export function actorName(actorId: string, me: string | null, names: ReadonlyMap<string, string>): string {
  if (me && actorId === me) return accountCopy.t('actorYou');
  if (OPERATOR_IDS.has(actorId) || actorId.startsWith('op:') || actorId.startsWith('founder:')) return accountCopy.t('actorIntafaced');
  return names.get(actorId) ?? accountCopy.t('actorUnknown');
}
