import type { AcademyLearnerPage, AcademyLearnerProgress, AcademyLearners } from '@intafaced/contracts/academy-learner-desk';
import type { IdentityLearnerCard } from '@intafaced/contracts/identity-learner-card';
import type { Part } from '@/lib/desk/part';

/**
 * The staff desk for one learner (J-academy-14). Pure, so the server loader, the route and the browser component share it.
 * The profile and sign-in statistics are identity's; everything else is svc-academy's.
 */
export type { AcademyLearnerPage, AcademyLearnerProgress, AcademyLearners, IdentityLearnerCard };

export interface LearnerView {
  readonly userId: string;
  readonly card: Part<IdentityLearnerCard | null>;
  readonly page: Part<AcademyLearnerPage>;
  readonly progress: Part<AcademyLearnerProgress>;
  readonly asOf: string;
}

export interface LearnersView {
  readonly tag: string | null;
  readonly report: Part<AcademyLearners>;
  readonly tags: Part<Array<{ tag: string; learners: number }>>;
}

export type LearnerDeskReply =
  | { readonly ok: true; readonly what: string }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };
