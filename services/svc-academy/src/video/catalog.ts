/**
 * Named VOD spine — the media half of the curriculum shelf.
 *
 * Store listing (bucket LIST) is Class X residual / n/a. Unknown slugs are not
 * invented. Object keys are constants here, never discovered from MinIO.
 */
/**
 * Optional media fields stay null until the owner sets them.
 * Nothing here guesses a duration, thumbnail, language or captions file.
 */
export type VideoSpineEntry = {
  readonly slug: string;
  readonly title: string;
  readonly path: 'foundations' | 'markets' | 'builder' | 'sovereign';
  readonly objectKey: string;
  readonly durationSeconds: number | null;
  readonly thumbnailUrl: string | null;
  readonly language: string | null;
  readonly captionsUrl: string | null;
};

export const VIDEO_SPINE: readonly VideoSpineEntry[] = [
  {
    slug: 'foundations-risk-first',
    title: 'Risk first',
    path: 'foundations',
    objectKey: 'foundations/risk-first.mp4',
    durationSeconds: null,
    thumbnailUrl: null,
    language: null,
    captionsUrl: null,
  },
];

export type VideoSpineItem = VideoSpineEntry;

export function listVideoSpine(): readonly VideoSpineItem[] {
  return VIDEO_SPINE;
}

export function getVideoSpineItem(slug: string): VideoSpineItem | undefined {
  return VIDEO_SPINE.find((item) => item.slug === slug);
}
