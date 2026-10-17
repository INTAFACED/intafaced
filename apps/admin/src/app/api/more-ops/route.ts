import { deskGet, deskPost } from '@/lib/ops-desk/route';

/**
 * More-modules ops desk. GET reads agents, quant and market as the signed-in founder. POST runs one step of a
 * two-founder request to approve, reject or suspend a market vendor (svc-market `vet`: market:ops, a second factor and
 * an identity approval a different founder signed).
 */

export const dynamic = 'force-dynamic';

export const GET = (request: Request) => deskGet(request, 'more');
export const POST = (request: Request) => deskPost(request, 'more', ['market.vendor.vet']);
