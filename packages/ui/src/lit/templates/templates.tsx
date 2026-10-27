/**
 * The eight templates every customer room is built from (every room in the redesign's inventory). A template fixes structure: its regions, their order on phone and
 * computer, which regions Simple and Pro show, the legal slots and the states. Rooms pass data and copy as slot
 * content, never styling. Layout follows the template's own width (container queries in templates.css).
 */
import * as React from 'react';
import { Stepper } from '../components/b2-basics.js';
import { GateArea, Region, RoomFrame, WHOLE_ROOM_STATES } from './frame.js';
import type { RoomProps } from './types.js';

type Slot = React.ReactNode;
const isPro = (p: RoomProps) => p.mode === 'pro';

// ---- Overview: balance or business home ---------------------------------------------------------------------

export interface OverviewProps extends RoomProps {
  /** The balance on a money surface, with its breakdown grouped by protection. */
  hero: Slot;
  /** At most four action keys, on one line. */
  actions?: Slot;
  /** Tasks the person must act on. */
  needsYou?: Slot;
  /** The door's rooms ("All in Money"). */
  rooms?: Slot;
  /** Holdings, recent activity: rows. */
  sections?: Slot;
  /** Pro: P&L over time, allocation, open orders and positions, watchlist. Ignored in Simple. */
  pro?: Slot;
  /** Computer right column under the In-flight lane: what the person watches. */
  watching?: Slot;
}

export function OverviewTemplate(p: OverviewProps) {
  return (
    <RoomFrame {...p} template="overview" liveBefore={p.rooms}>
      <Region name="rooms" ghost="keys" live>
        {p.rooms}
      </Region>
      <div className="lt-grid lt-grid-main-side">
        <div className="lt-col-main">
          <Region name="hero" data primary ghost="figure" label="Balance">
            {p.hero}
          </Region>
          <Region name="actions" data label="Actions" ghost="keys">
            {p.actions}
          </Region>
          <Region name="needs-you" data ghost="rows" label="Needs you">
            {p.needsYou}
          </Region>
          {isPro(p) ? (
            <Region name="pro" data ghost="chart" label="Performance">
              {p.pro}
            </Region>
          ) : null}
          <Region name="sections" data ghost="rows" label="Activity">
            {p.sections}
          </Region>
        </div>
        <div className="lt-col-side">
          <Region name="watching" data ghost="rows" label="Watching">
            {p.watching}
          </Region>
        </div>
      </div>
    </RoomFrame>
  );
}

// ---- Record list: filters, table, export; and each record's own page ---------------------------------------

export interface RecordListProps extends RoomProps {
  filters?: Slot;
  export?: Slot;
  /** Totals for the filtered records, when the room has them. */
  summary?: Slot;
  /** Simple: rows grouped by day. Pro: the dense table. The room passes the one its mode needs. */
  list: Slot;
  /** The selected record (the shared receipt). On a computer it sits beside the list; on a phone it is its own page. */
  detail?: Slot;
  /** `/x/:id` routes render only the record. */
  detailOnly?: boolean;
  /** Pro: column chooser, saved filters, bulk actions. */
  tools?: Slot;
}

export function RecordListTemplate(p: RecordListProps) {
  if (p.detailOnly) {
    return (
      <RoomFrame {...p} template="record-list">
        <div className="lt-grid lt-grid-reading">
          <Region name="detail" data primary ghost="rows" label="Details">
            {p.detail}
          </Region>
        </div>
      </RoomFrame>
    );
  }
  return (
    <RoomFrame {...p} template="record-list">
      <div className="lt-toolbar">
        <Region name="filters" ghost="keys">
          {p.filters}
        </Region>
        {isPro(p) ? <Region name="tools">{p.tools}</Region> : null}
        <Region name="export" data label="Export" ghost="keys">
          {p.export}
        </Region>
      </div>
      <Region name="summary" data ghost="figure" label="Summary">
        {p.summary}
      </Region>
      <div className={p.detail ? 'lt-grid lt-grid-list-detail' : 'lt-grid'}>
        <Region name="list" data primary ghost="rows" label="Records">
          {p.list}
        </Region>
        {p.detail ? (
          <Region name="detail" data ghost="rows" label="Details">
            {p.detail}
          </Region>
        ) : null}
      </div>
    </RoomFrame>
  );
}

// ---- Monitor: key figures, status panels, charts over time --------------------------------------------------

export interface MonitorProps extends RoomProps {
  /** Two to four key figures with their period. Simple shows the first only. */
  figures: readonly Slot[];
  /** The main chart with its range control. Every chart carries its table (its text equivalent). */
  chart?: Slot;
  /** Status panels. */
  panels?: Slot;
  /** What the figures mean, in plain words. */
  explain?: Slot;
  /** The room's one action (on an asset page: Buy and Sell, equal weight, one Review). */
  actions?: Slot;
  /** Pro: more charts, ranges, compare. */
  pro?: Slot;
  related?: Slot;
}

export function MonitorTemplate(p: MonitorProps) {
  const figures = isPro(p) ? p.figures : p.figures.slice(0, 1);
  return (
    <RoomFrame {...p} template="monitor">
      <Region name="figures" data primary ghost="figure" label="Key figures">
        {figures.length > 0 ? (
          <div className="lt-figures" data-count={figures.length}>
            {figures.map((f, i) => (
              <div key={i} className="lt-figure-cell">
                {f}
              </div>
            ))}
          </div>
        ) : null}
      </Region>
      <Region name="actions" data label="Actions" ghost="keys">
        {p.actions}
      </Region>
      <div className="lt-grid lt-grid-main-side">
        <div className="lt-col-main">
          <Region name="chart" data ghost="chart" label="Chart">
            {p.chart}
          </Region>
          {isPro(p) ? (
            <Region name="pro" data ghost="chart" label="More charts">
              {p.pro}
            </Region>
          ) : null}
          <Region name="panels" data ghost="grid" label="Details">
            {p.panels}
          </Region>
        </div>
        <div className="lt-col-side">
          <Region name="explain" ghost="text" label="What this means">
            {p.explain}
          </Region>
          <Region name="related" data ghost="rows" label="Related">
            {p.related}
          </Region>
        </div>
      </div>
    </RoomFrame>
  );
}

// ---- Flow: one task, review, receipt ------------------------------------------------------------------------

export interface FlowProps extends RoomProps {
  /** Step names and where the person is. Simple asks one question per screen on a phone. */
  steps?: { labels: readonly string[]; current: number };
  /** The current step (Simple) or every field (Pro). */
  step: Slot;
  /** The live summary: right column on a computer, one line above the button on a phone. */
  summary?: Slot;
  /** Back and one button that names the action. */
  actions?: Slot;
  /** Pro: advanced options (network and fee speed, slippage limit, schedule). */
  advanced?: Slot;
  /** "Talk to a person" and the complaint link (Directive 2023/2673 Art 16d; Consumer Duty). */
  help?: Slot;
}

/**
 * Where the stepper stands follows the state, so it never contradicts it: empty is the first step, confirm is the
 * last (review), and once money has moved (status, receipt) the steps are over and the stepper goes.
 */
function stepNow(p: FlowProps): number | null {
  if (!p.steps) return null;
  switch (p.state.kind) {
    case 'money-status':
    case 'receipt':
      return null;
    case 'empty':
      return 0;
    case 'confirm':
      return p.steps.labels.length - 1;
    default:
      return p.steps.current;
  }
}

export function FlowTemplate(p: FlowProps) {
  const current = stepNow(p);
  return (
    <RoomFrame {...p} template="flow" liveAfter={p.help}>
      {p.steps && current !== null ? <Stepper labels={p.steps.labels} current={current} /> : null}
      <div className="lt-grid lt-grid-flow">
        <div className="lt-col-main">
          <Region name="step" data primary ghost="form" label="This step">
            {p.step}
          </Region>
          {isPro(p) ? (
            <Region name="advanced" data ghost="form" label="Advanced">
              {p.advanced}
            </Region>
          ) : null}
          <Region name="actions" data ghost="keys" ghostCount={2} label="Actions">
            {p.actions}
          </Region>
        </div>
        <div className="lt-col-side">
          <Region name="summary" data ghost="rows" label="Summary">
            {p.summary}
          </Region>
          <Region name="help" live>
            {p.help}
          </Region>
        </div>
      </div>
    </RoomFrame>
  );
}

// ---- Settings: sections of switches, limits, keys -----------------------------------------------------------

export interface SettingsProps extends RoomProps {
  /** Section index: a list on a phone (then each section is its own page), a column on a computer. */
  index?: Slot;
  /** The open section's rows. Simple passes the common settings; Pro every setting. */
  sections: Slot;
  /** What each setting means and its consequence now, in plain words. */
  explain?: Slot;
}

export function SettingsTemplate(p: SettingsProps) {
  return (
    <RoomFrame {...p} template="settings" gateArea>
      <div className="lt-grid lt-grid-settings">
        <Region name="index" label="Sections" ghost="rows" live>
          {p.index}
        </Region>
        <GateArea>
          <Region name="sections" data primary ghost="rows" label="Settings">
            {p.sections}
          </Region>
          <Region name="explain" ghost="text" label="What this means">
            {p.explain}
          </Region>
        </GateArea>
      </div>
    </RoomFrame>
  );
}

// ---- Catalogue: browse products, pick one -------------------------------------------------------------------

export interface CatalogueProps extends RoomProps {
  filters?: Slot;
  /** One featured item, not a carousel. */
  featured?: Slot;
  /** Simple: cards with the one figure that matters and the plain risk line. Pro: the comparison table. */
  items: Slot;
  /** Item mode: one product's own page (hero, what you get, cost, risks, legal links, one action). */
  item?: Slot;
}

export function CatalogueTemplate(p: CatalogueProps) {
  if (p.item !== undefined) {
    return (
      <RoomFrame {...p} template="catalogue">
        <div className="lt-grid lt-grid-reading">
          <Region name="item" data primary ghost="text" label="Product">
            {p.item}
          </Region>
        </div>
      </RoomFrame>
    );
  }
  return (
    <RoomFrame {...p} template="catalogue" liveBefore={p.filters}>
      <Region name="filters" ghost="keys" live>
        {p.filters}
      </Region>
      {!isPro(p) ? (
        <Region name="featured" data ghost="figure" label="Featured">
          {p.featured}
        </Region>
      ) : null}
      <Region name="items" data primary ghost="grid" label="Products">
        {p.items}
      </Region>
    </RoomFrame>
  );
}

// ---- Desk: chart, book, ticket ------------------------------------------------------------------------------

export interface DeskProps extends RoomProps {
  /** Pair, last price with its time, 24 h figures. */
  instrument: Slot;
  chart: Slot;
  book?: Slot;
  tape?: Slot;
  /** Available, fee, total; Buy and Sell as one switch with one Review. A sheet on a phone. */
  ticket: Slot;
  orders?: Slot;
  pairs?: Slot;
}

/**
 * Pro is the desk. In Simple the room stays visible (never hidden): chart first, the ticket, and nothing else.
 * Every panel has an explicit grid area (auto-placement can break a fixed row).
 */
export function DeskTemplate(p: DeskProps) {
  const pro = isPro(p);
  if (WHOLE_ROOM_STATES.has(p.state.kind)) {
    // A whole-room state takes the main column, never the narrow ticket column.
    return (
      <RoomFrame {...p} template="desk">
        <div className="lt-grid lt-grid-reading">
          <Region name="ticket" primary label="Order" />
        </div>
      </RoomFrame>
    );
  }
  return (
    <RoomFrame {...p} template="desk">
      <div className="lt-desk" data-desk={pro ? 'pro' : 'simple'}>
        <Region name="instrument" data ghost="figure" label="Price">
          {p.instrument}
        </Region>
        {pro ? (
          <Region name="pairs" data ghost="rows" label="Markets">
            {p.pairs}
          </Region>
        ) : null}
        <Region name="chart" data ghost="chart" label="Chart">
          {p.chart}
        </Region>
        {pro ? (
          <Region name="book" data ghost="rows" label="Order book">
            {p.book}
          </Region>
        ) : null}
        {pro ? (
          <Region name="tape" data ghost="rows" label="Trades">
            {p.tape}
          </Region>
        ) : null}
        <Region name="ticket" data primary ghost="form" label="Order">
          {p.ticket}
        </Region>
        {pro ? (
          <Region name="orders" data ghost="rows" label="Orders and positions">
            {p.orders}
          </Region>
        ) : null}
      </div>
    </RoomFrame>
  );
}

// ---- Reading: help, status, docs, fees ----------------------------------------------------------------------

export interface ReadingProps extends RoomProps {
  /** Date and reading time. */
  meta?: Slot;
  /** Table of contents: beside the article on a computer, a sheet on a phone. */
  toc?: Slot;
  body: Slot;
  related?: Slot;
  contact?: Slot;
  /** The regulated-status line and fees policy link (A1.5, MiCA 66(4)). */
  footer?: Slot;
}

/** Simple and Pro show the same content here; Pro only changes density. */
export function ReadingTemplate(p: ReadingProps) {
  return (
    <RoomFrame {...p} template="reading" gateArea>
      <div className="lt-grid lt-grid-reading-toc">
        <Region name="toc" data ghost="rows" label="On this page" live>
          {p.toc}
        </Region>
        <GateArea>
          <div className="lt-reading-main">
            <Region name="meta" data label="Details" ghost="text">
              {p.meta}
            </Region>
            <Region name="body" data primary ghost="text" label="Article">
              {p.body}
            </Region>
            <Region name="related" data ghost="rows" label="Related">
              {p.related}
            </Region>
          </div>
        </GateArea>
      </div>
      <Region name="contact" live>
        {p.contact}
      </Region>
      <Region name="footer">{p.footer}</Region>
    </RoomFrame>
  );
}
