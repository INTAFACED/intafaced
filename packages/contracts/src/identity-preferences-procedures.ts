import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { uiViewPreferenceSchema } from './ui-view-preferences.js';
import { homeTilesPreferenceSchema } from './home-tiles-preferences.js';
import { tradeInstantPreferenceSchema } from './trade-instant-preferences.js';
import { savedScreensPreferenceSchema, watchlistsPreferenceSchema } from './watchlists-preferences.js';
import { addressWatchesPreferenceSchema, tokenWatchlistPreferenceSchema } from './protocol-watch-preferences.js';
import { deskLayoutsPreferenceSchema } from './desk-layouts-preferences.js';
import { chartTemplatesPreferenceSchema } from './chart-templates-preferences.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `preferences.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const TRADE_VIEWS_NAMESPACE = 'trade.views' as const;

export const view = z
  .object({
    id: z.string(),
    name: z.string(),
    sort: z.string(),
    filters: z.record(z.string(), z.string()),
    columns: z.array(z.string()),
  })
  .strict();

export const tradeViewsPreference = z
  .object({ namespace: z.literal(TRADE_VIEWS_NAMESPACE), version: z.number().int(), value: z.array(view).nullable() })
  .strict();

export const ACCOUNT_DISPLAY_NAMESPACE = 'account.display' as const;

export const accountDisplay = z.object({ locale: z.string().nullable(), displayCurrency: z.string().nullable() }).strict();

export const accountDisplayPreference = z
  .object({ namespace: z.literal(ACCOUNT_DISPLAY_NAMESPACE), version: z.number().int(), value: accountDisplay.nullable() })
  .strict();

export const preference = z.union([
  tradeViewsPreference,
  accountDisplayPreference,
  uiViewPreferenceSchema,
  homeTilesPreferenceSchema,
  tradeInstantPreferenceSchema,
  watchlistsPreferenceSchema,
  savedScreensPreferenceSchema,
  tokenWatchlistPreferenceSchema,
  addressWatchesPreferenceSchema,
  deskLayoutsPreferenceSchema,
  chartTemplatesPreferenceSchema,
]);

export const IDENTITY_PREFERENCES_GET = defineProcedure({
  ...base,
  name: 'identity.preferences.get',
  kind: 'query',
  path: 'preferences.get',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: z.object({ namespace: z.string().min(1).max(64) }).strict(),
  output: preference,
  outputChecks: {
    unique_ids_holds: { at: ['output|3.value.order', 'output|3.value.hidden'], says: 'each tile once' },
    instant_holds: { at: 'output|4.value|0.agreedAt', says: 'a real instant' },
    watchlists_value_holds: { at: 'output|5.value', says: 'each list id once' },
    watchlist_holds: { at: 'output|5.value[]', says: 'each symbol once in a list' },
    watchlist_section_holds: { at: 'output|5.value[].sections[]', says: 'each symbol once in a section' },
    saved_screens_value_holds: { at: 'output|6.value', says: 'each screen id once' },
    token_watchlist_value_holds: { at: 'output|7.value', says: 'each token once' },
    address_watches_value_holds: { at: 'output|8.value', says: 'each address once' },
    desk_layouts_value_holds: { at: 'output|9.value', says: 'active names a layout; each layout name once; each layout id once' },
    desk_workspace_v1_holds: {
      at: ['output|9.value.layouts[].desk|0', 'output|9.value.deleted[].desk|0'],
      says: 'a linked panel is on the desk; each widget once',
    },
    desk_links_holds: {
      at: ['output|9.value.layouts[].desk|0.links', 'output|9.value.deleted[].desk|0.links'],
      says: "each group has a member; each member's group carries a market",
    },
    desk_workspace_v2_holds: {
      at: ['output|9.value.layouts[].desk|1', 'output|9.value.deleted[].desk|1'],
      says: 'no two panels on one cell; a linked panel is on the desk; each panel id once',
    },
    settings_holds: {
      at: ['output|9.value.layouts[].desk|1.panels[].settings', 'output|9.value.deleted[].desk|1.panels[].settings'],
      says: 'settings too large',
    },
    grid_holds: {
      at: ['output|9.value.layouts[].desk|1.panels[].grid', 'output|9.value.deleted[].desk|1.panels[].grid'],
      says: 'inside the rows; inside the columns',
    },
    desk_panel_links_holds: {
      at: ['output|9.value.layouts[].desk|1.links', 'output|9.value.deleted[].desk|1.links'],
      says: "each group has a member; each member's group carries a market",
    },
    defaults_holds: { at: 'output|9.value.defaults', says: 'too many desks' },
    chart_templates_value_holds: { at: 'output|10.value', says: 'each template name once; each template id once' },
    chart_template_holds: { at: 'output|10.value.templates[]', says: 'each study id once' },
    template_drawings_holds: { at: 'output|10.value.templates[].drawings', says: 'each drawing id once' },
  },
  samples: [
    { verdict: 'accept', input: { namespace: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
