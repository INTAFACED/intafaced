import type { AcademyCourseItemRules } from '@intafaced/contracts/academy-course-item-rules';
import type { Part } from '@/lib/desk/part';

/**
 * A course's prerequisites and learners' own due dates on the founder console (AC-release-access-02). Pure, so the
 * server loader, the route and the browser component share it.
 */
export type { AcademyCourseItemRules };

export interface ItemRulesView {
  readonly rules: Part<AcademyCourseItemRules>;
  readonly asOf: string;
}

export type ItemRulesDeskReply =
  | { readonly ok: true; readonly what: string; readonly rules: AcademyCourseItemRules }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };
