import { deskGet, deskPost } from '@/lib/ops-desk/route';

/**
 * bank ops desk. GET reads the owning service's operator reads as the signed-in founder. POST runs one step of a two-founder
 * request to freeze or unfreeze one card as an operator (svc-bank `ops.setCardStatus`: treasury permission, a second factor and
 * an identity approval a different founder signed). Bank money jobs are not here.
 */

export const dynamic = 'force-dynamic';

export const GET = (request: Request) => deskGet(request, 'bank');
export const POST = (request: Request) => deskPost(request, 'bank', ['bank.card.status']);
