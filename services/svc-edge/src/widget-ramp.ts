import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Retired ramp iframe widget.
 *
 * GET /api/widget/ramp used to serve a page other websites could frame
 * (any origin allowed, X-Frame-Options removed). The two frames inside it
 * refused framing, so it never worked, and a framable money page is a
 * clickjacking surface we do not want. It now answers 410 with framing
 * denied. ADR: docs/adr/2026-10-14-ramp-widget-no-third-party-framing.md.
 *
 * Each hit is logged with Sec-Fetch-Dest and the Referer ORIGIN only (never
 * the path or query), so the ADR's revisit trigger can be measured.
 */

export const WIDGET_RAMP_PATH = '/api/widget/ramp' as const;
export const WIDGET_IFRAME_RETIRED = 'ops.widget_iframe_retired' as const;
export const WIDGET_IFRAME_RETIRED_MESSAGE =
  'The embeddable ramp widget is retired. The ramp is not offered inside third-party pages.' as const;

/** Referer reduced to its origin. Anything missing, unparsable or opaque becomes 'none'. */
export function refererOrigin(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return 'none';
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? 'none' : origin;
  } catch {
    return 'none';
  }
}

/** Sec-Fetch-Dest is a fixed token list (iframe, document, ...). Anything else is 'none'. */
export function fetchDest(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && /^[a-z-]{1,24}$/.test(value) ? value : 'none';
}

export function registerWidgetRampRoute(app: FastifyInstance): void {
  app.get(WIDGET_RAMP_PATH, async (req: FastifyRequest, reply: FastifyReply) => {
    req.log.info(
      { secFetchDest: fetchDest(req.headers['sec-fetch-dest']), refererOrigin: refererOrigin(req.headers.referer) },
      'edge: retired ramp widget requested',
    );
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "frame-ancestors 'none'");
    reply.header('cache-control', 'no-store');
    return reply.code(410).send({ code: WIDGET_IFRAME_RETIRED, message: WIDGET_IFRAME_RETIRED_MESSAGE });
  });
}
