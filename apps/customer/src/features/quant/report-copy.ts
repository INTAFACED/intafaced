import { defineCopy } from '../../shared/i18n';

// The printable report and the share link of one stored bar backtest (AL-report-03, J-algo-dev-02 #6 and #7), and the
// page a signed-out reader opens from that link. Figures, times and links enter through parameters.
const en = {
  tabReport: 'Report',
  tabShare: 'Share',
  reportTitle: 'Printable report',
  reportIntro: 'The report is built from this stored run each time it opens. Print it, or save it as a PDF from the print window.',
  print: 'Print report',
  reportLoading: 'Building the report',
  section_parameters: 'Parameters',
  section_statistics: 'Statistics',
  section_charts: 'Charts',
  section_coverage: 'Data coverage',
  section_warnings: 'Warnings',
  section_labels: 'Labels',
  rowName: 'Item',
  rowValue: 'Value',
  shareTitle: 'Share this result',
  shareIntro:
    'A share link lets anyone with it read this result signed out: the simulation label, the checks, the coverage and the figures. It never shows your account, the strategy’s source or the run key.',
  shareLoading: 'Reading the share link',
  shareNone: 'This run has no active link.',
  shareActive: 'A link to this run is active.',
  shareCount: 'Links made for this run: {count}.',
  create: 'Create link',
  creating: 'Creating the link',
  revoke: 'Revoke link',
  revoking: 'Revoking the link',
  revoked: 'The link is revoked. Anyone who opens it now reads “not found”.',
  linkLabel: 'Share link',
  linkOnce:
    'This link is shown once. Copy it now: it is not stored where it can be shown again. To get a new one, revoke this link and create another.',
  linkLost: 'This link was already created and its address is shown only once. Revoke it and create another to get a new address.',
  embedLabel: 'Embed code',
  embedOrigins: 'Sites that may show it in a frame: {origins}.',
  embedFramePolicy:
    'Another site cannot show this frame yet: this site’s own frame policy still refuses every outside frame. The link opens on its own.',
  embedUnset: 'Embedding is not available: the list of sites that may show a shared result in a frame is not set. The link still opens.',
  shareRateUnset: 'Sharing is not available: the limit on how often a shared result may be read is not set.',
  shareWindowUnset: 'Sharing is not available: the time window for that read limit is not set.',
  // The signed-out page a share link opens.
  publicTitle: 'Shared backtest result',
  publicLoading: 'Opening the shared result',
  publicNotFound: 'This shared result was not found. The link may have been revoked, or it was copied incompletely.',
  publicBusy: 'This shared result cannot be read right now: its read limit is used up or allows no reads. Try again later.',
  publicWindow: '{symbol}, {from} to {to} (UTC).',
  publicCoverage: 'Bars read: {bars} of {expected}.',
  publicCosts: 'Fee {feeRole} at {feeBps} basis points; slippage {slippageBps} basis points; delay {delayBars} bars.',
  publicTotals: 'Totals',
  publicMetrics: 'Figures',
  publicVerdict: 'Out-of-sample verdict: {status}.',
  publicVariants: 'Variants tried on this strategy: {count}.',
  publicVariantsUnknown: 'Variants tried on this strategy: not recorded.',
  publicChecks: 'Checks',
  publicWarnings: 'Warnings',
  publicNoWarnings: 'No warnings were recorded.',
  publicChart: 'Equity: {points} points, from {first} to {last}; lowest {low}, highest {high}.',
  publicChartNone: 'No equity points were recorded.',
  notDefined: 'not defined',
} as const;

export const reportCopy = defineCopy('quant.report', en);
