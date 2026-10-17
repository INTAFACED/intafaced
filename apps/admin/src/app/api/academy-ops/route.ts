import { deskGet, deskPost } from '@/lib/ops-desk/route';

/**
 * Academy ops desk. GET reads svc-academy as the signed-in founder. POST runs one step of a two-founder request to
 * appoint an ambassador, freeze or lift the freeze on one, or decide a residency application: a different founder must approve at identity, and svc-academy spends the
 * approval once (and needs the operator permission on the founder session, or it refuses and the desk says so).
 */

export const dynamic = 'force-dynamic';

export const GET = (request: Request) => deskGet(request, 'academy');
export const POST = (request: Request) =>
  deskPost(request, 'academy', [
    'academy.ambassador.appoint',
    'academy.ambassador.freeze',
    'academy.ambassador.unfreeze',
    'academy.residency.decide',
  ]);
