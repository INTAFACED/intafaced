/** Where the CRM skip link lands: the enquiry list, or (on a phone showing one enquiry, with the list hidden) that enquiry's heading. */
export type SkipTarget = 'list' | 'detail';

export function skipTarget(listShown: boolean, detailHeadingShown: boolean): SkipTarget | null {
  if (listShown) return 'list';
  return detailHeadingShown ? 'detail' : null;
}

/** The link says where it lands. With nothing to point at it keeps the default wording (the link is hidden then anyway). */
export function skipLabel(target: SkipTarget | null): string {
  return target === 'detail' ? 'Skip to enquiry' : 'Skip to enquiries';
}
