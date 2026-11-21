import 'server-only';
import type { SupportHelpCentre, SupportHelpCentreTranslationList } from '@intafaced/contracts';
import { SUPPORT_DESK_HELP_CENTRE_TRANSLATIONS, SUPPORT_HELP_CENTRE } from '@intafaced/contracts/support-desk-settings-procedures';
import { founderRecordCall, type FounderCallContext, partFrom, type Part, type PartLabels } from '@/lib/desk';
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
    founderRecordCall(ctx, SUPPORT_HELP_CENTRE, undefined),
    founderRecordCall(ctx, SUPPORT_DESK_HELP_CENTRE_TRANSLATIONS, { limit: HELP_CENTRE_TRANSLATION_PAGE }),
  ]);
  return {
    asOf: now.toISOString(),
    settings: partFrom(settings, (s) => s, LABELS),
    translations: partFrom(translations, (t) => t, LABELS),
  };
}
