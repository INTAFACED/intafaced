import 'server-only';
import { quantPromotionAuditSchema, type QuantPromotionAudit } from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part, type PartLabels } from '@/lib/desk/part';

/**
 * The promotion audit on the quant desk (AL-lifecycle-01, J-algo-dev-13 #3), as the signed-in founder: every gate
 * decision svc-quant stores, newest first, with the one stage row an approval wrote, who pressed and the owner criteria
 * the gate judged by (`ops.lifecycle.audit`, `admin:read`, module quant). A read only; nothing here writes or moves money.
 */

const QUANT: PartLabels = {
  service: 'svc-quant',
  forbiddenMessage: 'svc-quant did not accept your founder session for the promotion audit (it needs admin:read with module quant).',
};

const readAudit = parseWith(quantPromotionAuditSchema);

export async function loadPromotionAudit(ctx: FounderCallContext): Promise<Part<QuantPromotionAudit>> {
  return partFrom(await founderCall(ctx, 'quant', 'ops.lifecycle.audit', 'GET', undefined, readAudit), (d) => d, QUANT);
}
