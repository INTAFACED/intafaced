// The routes the screenshot board shoots for the money pages: [id from the page inventory, title, address, also shoot at phone width, who is signed in].
// Read by ../board/shoot.mjs and ../board/crawl.mjs. Keep this list to routes this package owns, and add a row when you add a page.
// The signed-in person defaults to the owner; 'payfac' signs in as a platform owner so Network and Permissions show.
export const board = [
  ['P24', 'Balances', '/pay/money', true],
  ['P25', 'Statement', '/pay/money/activity', false],
  ['P26', 'Settlements', '/pay/settlements', true],
  ['P27', 'Settlement detail', '/pay/settlements/bb000006-0000-4000-8000-000000000006', false],
  ['P28', 'Payouts', '/pay/payouts', true],
  ['P29', 'New payout', '/pay/payouts/new', true],
  ['P30', 'Payout detail', '/pay/payouts/bb000006-0000-4000-8000-000000000006', false],
  ['P31', 'Approvals', '/pay/approvals', true],
  ['P32', 'Destinations', '/pay/payouts/destinations', false],
  ['P08', 'Refunds', '/pay/refunds', true],
  ['P09', 'Issue a refund', '/pay/refunds/new', false],
  ['P10', 'Refund detail', '/pay/refunds/TEST-refund-1', false],
  ['P33', 'Conversion', '/pay/conversion', false],
  ['P34', 'New conversion', '/pay/conversion/new', false],
  ['P35', 'Conversion detail', '/pay/conversion/TEST-order-1', false],
  ['P36', 'Pricing', '/pay/pricing', false],
  ['P37', 'Limits', '/pay/limits', false],
];
