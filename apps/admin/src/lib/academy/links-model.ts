import type { AcademyCourseLearnerView, AcademyPrivateLink } from '@intafaced/contracts/academy-courses';
import type { Part } from '@/lib/desk/part';

/**
 * Preview as new learner and private links (AC-catalogue-03). Pure, so the server loader, the route and the browser
 * components share it.
 */
export type { AcademyCourseLearnerView, AcademyPrivateLink };

export interface PreviewView {
  readonly view: Part<AcademyCourseLearnerView>;
  readonly asOf: string;
}

export interface LinksView {
  readonly links: Part<AcademyPrivateLink[]>;
  readonly asOf: string;
}

/** A new link comes back with its key once; the desk shows it then and never again. */
export type LinksDeskReply =
  | { readonly ok: true; readonly what: string; readonly path: string | null }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };
