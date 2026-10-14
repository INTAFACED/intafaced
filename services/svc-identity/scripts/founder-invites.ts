import { generateFounderInvites, INVITE_TTL_HOURS } from '../src/auth/founder-enrolment.js';

/**
 * Prints two single-use founder invite codes and the two environment lines that
 * configure them. `pnpm --filter @intafaced/svc-identity founder:invites`.
 *
 * Local only: randomness in, stdout out. No network, no files, no database, and
 * it does not read the service environment. Run it where the output may be seen
 * by the operator only, hand each code to its founder over a channel separate
 * from the enrolment link, and put ONLY the two env lines in the deployment.
 * The codes are never stored anywhere; lose them and generate again.
 */
const invites = generateFounderInvites();

console.log(`Founder invite codes (valid ${INVITE_TTL_HOURS} hours, each works once). Show them to the two founders only:\n`);
invites.codes.forEach((code, i) => console.log(`  Invite ${i + 1}: ${code}`));
console.log('\nPut exactly these two lines in the svc-identity environment (hashes and expiry, never the codes):\n');
for (const line of invites.envLines) console.log(line);
console.log('\nThe door closes by itself once the founder pair is pinned. Unset both variables afterwards.');
