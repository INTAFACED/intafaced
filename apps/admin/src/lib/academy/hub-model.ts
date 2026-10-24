import type { AcademyFeaturedSlot, AcademyTopic, AcademyTopicList } from '@intafaced/contracts/academy-courses';
import type { Part } from '@/lib/desk/part';

/**
 * The Learn hub desk (AC-articles-01): the featured article and the topics, as staff set them. Pure, so the server
 * loader, the route and the browser components share it.
 */
export type { AcademyFeaturedSlot, AcademyTopic, AcademyTopicList };

export interface HubView {
  readonly slot: Part<AcademyFeaturedSlot>;
  readonly topics: Part<AcademyTopicList>;
  readonly asOf: string;
}

export type HubDeskReply =
  | { readonly ok: true; readonly what: string }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };
