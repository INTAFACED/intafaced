import 'server-only';
import {
  supportHelpCentreSchema,
  supportHelpCentreTranslationListSchema,
  type SupportHelpCentre,
  type SupportHelpCentreTranslationList,
} from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part, type PartLabels } from '@/lib/desk/part';
import { SUPPORT_OPS_FORBIDDEN, SUPPORT_OPS_FORBIDDEN_BODY } from './refusal';

/** How many article-version × language rows the desk reads in one page. A page size of this screen, not an owner value. */
export const HELP_CENTRE_TRANSLATION_PAGE = 100;

export interface HelpCentreDeskView {
  readonly asOf: string;
  readonly settings: Part<SupportHelpCentre>;
  readonly translations: Part<SupportHelpCentreTranslationList>;
}

const LABELS: PartLabels = {
  service: 'svc-support',
  forbiddenMessage: `${SUPPORT_OPS_FORBIDDEN}. ${SUPPORT_OPS_FORBIDDEN_BODY}`,
};

/** The help centre settings and its translation gaps, each read on its own, as the signed-in founder. */
export async function loadHelpCentre(ctx: FounderCallContext, now: Date = new Date()): Promise<HelpCentreDeskView> {
  const [settings, translations] = await Promise.all([
    founderCall(ctx, 'support', 'helpCentre', 'GET', undefined, parseWith(supportHelpCentreSchema)),
    founderCall(
      ctx,
      'support',
      'helpCentreTranslations',
      'GET',
      { limit: HELP_CENTRE_TRANSLATION_PAGE },
      parseWith(supportHelpCentreTranslationListSchema),
    ),
  ]);
  return {
    asOf: now.toISOString(),
    settings: partFrom(settings, (s) => s, LABELS),
    translations: partFrom(translations, (t) => t, LABELS),
  };
}
