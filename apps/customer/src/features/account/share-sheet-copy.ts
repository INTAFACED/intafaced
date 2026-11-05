import { defineCopy } from '../../shared/i18n';

export const shareSheetCopy = defineCopy('account.shareSheet', {
  title: 'One-tap share',
  body: 'Each share carries a signed tag for where it was shared from. Edited tags are refused, and one browser session counts once.',
  share: 'Share',
  shared: 'Share link ready and copied.',
  sharedNative: 'Share link sent to your device’s share menu.',
  copyUnavailable: 'Copy is unavailable. Select the share link above.',
  link: 'Share link · promotion page',
  shareText: 'Join me on INTAFACED with my invitation link.',
  visits: 'Visits by surface',
  refresh: 'Refresh counts',
  surface_promotion: 'Promotion page',
  surface_card: 'Cards',
  surface_token: 'Token pages',
  surface_strategy: 'Strategies',
  surface_receipt: 'Receipts',
  noLink: 'Get your invitation link first. One-tap share tags your live link; it never makes one.',
  keyUnset: 'One-tap share is off: the signing key for share tags is not set. Your invitation link still works.',
  refused: 'The service refused to make a share link. Nothing was shared.',
  statsFailed: 'Visit counts could not be read.',
});
