import { createHash, randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import {
  DRAW_OWNER_QUESTION,
  DRAW_USER_TYPES,
  type CampaignDraw,
  type CampaignState,
  type DrawBoard,
  type DrawUserType,
} from '@intafaced/contracts/campaigns-catalogue';
import { CampaignsError } from './codes.js';
import { effectiveState } from './campaigns.js';
import type { CompetitionFillSource } from './competitions.js';
import type { ParticipantSource } from './participants.js';

/**
 * Lucky draws (CM-promotions-events-02, J-campaigns-12). A `draw` campaign gives each entrant chances for their activity:
 * its chances per fill for each fill the venue reports of an order they placed through INTAFACED after joining (our
 * builder fee above zero), counted once per fill, up to the cap for their user type (the verification level svc-identity
 * reports). Its prize table is paid from the campaign's budget.
 *
 * - The seed: 32 random bytes made here before the draw takes its first chance, and kept only in
 *   `campaigns.draw_seeds`. Everyone sees its commitment, SHA-256 of the seed. No door reads the seed itself.
 * - The entry list: each entrant as SHA-256 of their account id with their chances, in join order; its hash is shown as
 *   it stands, so after a draw anyone can check the list it was drawn from.
 * - The winners (`drawWinners`): a documented function of the seed and the entry list, so anyone can recompute them.
 * - Running and settling a draw wait for the owner's decision on chance-based rewards (OWNER 87). Until it is recorded,
 *   `run` and `settle` refuse `owner.decision` naming the question, write an audit row of the attempt and nothing else:
 *   no winner, no reward intent, nothing paid. No decision is recorded anywhere in this version, so nothing here draws.
 */

type Sql = postgres.Sql;

type DrawRow = {
  id: string;
  type: string;
  state: CampaignState;
  starts_at: Date | null;
  ends_at: Date | null;
  budget_asset: string | null;
  budget_limit: string | null;
  draw: CampaignDraw | null;
};

type Terms = { chancesPerFill: number; caps: { userType: DrawUserType; cap: number }[]; prizes: CampaignDraw['prizes'] };

type EntrantRow = { account_id: string; joined_at: Date; chances: number; fills: number };

const OPEN_STATES: readonly CampaignState[] = ['active', 'paused'];
const CLOSED_STATES: readonly CampaignState[] = ['ended', 'closed', 'archived'];

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** One line of the entry list: the entrant's id hashed, never shown in the clear, and their chances. */
export interface DrawEntry {
  readonly entrant: string;
  readonly chances: number;
}

/** The entry list's hash: each entry as `<entrant>:<chances>`, in join order, one per line. */
export function entryHashOf(entries: readonly DrawEntry[]): string {
  return sha256(entries.map((e) => `${e.entrant}:${e.chances}`).join('\n'));
}

/** An account id as the entry list names it. */
export const entrantOf = (accountId: string) => sha256(`draw-entrant:${accountId.toLowerCase()}`);

/**
 * The winners of a draw: for place r = 1, 2, ..., h = SHA-256(seed ":" entryHash ":" r), read as a number, picks chance
 * h mod (the chances still in the draw), counted along the entry list in order; the entrant holding it wins place r and
 * leaves the draw with all their chances. Fewer entrants with chances than places leaves the later places unwon.
 */
export function drawWinners(seed: string, entries: readonly DrawEntry[], places: number): { rank: number; entrant: string }[] {
  const hash = entryHashOf(entries);
  const left = entries.filter((e) => e.chances > 0).map((e) => ({ ...e }));
  const out: { rank: number; entrant: string }[] = [];
  for (let rank = 1; rank <= places && left.length > 0; rank += 1) {
    const total = left.reduce((n, e) => n + BigInt(e.chances), 0n);
    let pick = BigInt(`0x${sha256(`${seed}:${hash}:${rank}`)}`) % total;
    const at = left.findIndex((e) => {
      if (pick < BigInt(e.chances)) return true;
      pick -= BigInt(e.chances);
      return false;
    });
    out.push({ rank, entrant: left[at]!.entrant });
    left.splice(at, 1);
  }
  return out;
}

/**
 * Checks a draw anyone can recompute: the seed matches its commitment, the entry list matches the published entry hash,
 * and the winners drawn from them are the stored ones. A changed entry list fails at its hash.
 */
export function verifyDraw(input: {
  seed: string;
  commitment: string;
  entryHash: string;
  entries: readonly DrawEntry[];
  winners: readonly { rank: number; entrant: string }[];
}): boolean {
  if (sha256(input.seed) !== input.commitment) return false;
  if (entryHashOf(input.entries) !== input.entryHash) return false;
  const again = drawWinners(input.seed, input.entries, input.winners.length);
  return (
    again.length === input.winners.length &&
    again.every((w, i) => w.rank === input.winners[i]!.rank && w.entrant === input.winners[i]!.entrant)
  );
}

export interface DrawServiceOptions {
  sql: Sql;
  fills: CompetitionFillSource | null;
  participants: ParticipantSource | null;
  now?: () => Date;
  log?: (msg: string, detail: Record<string, unknown>) => void;
}

export class DrawService {
  private readonly sql: Sql;
  private readonly fills: CompetitionFillSource | null;
  private readonly participants: ParticipantSource | null;
  private readonly now: () => Date;
  private readonly log: (msg: string, detail: Record<string, unknown>) => void;

  constructor(options: DrawServiceOptions) {
    this.sql = options.sql;
    this.fills = options.fills;
    this.participants = options.participants;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  private async row(campaignId: string): Promise<DrawRow> {
    const [row] = await this.sql<DrawRow[]>`
      SELECT id, type, state, starts_at, ends_at, budget_asset, budget_limit::text AS budget_limit, draw
      FROM campaigns.campaigns WHERE id = ${campaignId}`;
    if (!row || ['draft', 'pending_approval', 'approved'].includes(row.state)) {
      throw new CampaignsError('campaign.unknown', 'No such campaign');
    }
    if (row.type !== 'draw') throw new CampaignsError('campaigns.not_draw', 'This campaign is not a draw');
    return row;
  }

  /** The terms a live draw must have (the activation gate made sure); a row without them refuses. */
  private terms(row: DrawRow): Terms {
    const d = row.draw;
    const caps = DRAW_USER_TYPES.map((userType) => ({ userType, cap: d?.caps.find((c) => c.userType === userType)?.cap ?? null }));
    if (!d || d.chancesPerFill === null || caps.some((c) => c.cap === null) || !row.budget_asset || row.budget_limit === null) {
      throw new CampaignsError('campaigns.draw_unset', 'This draw is missing its terms');
    }
    return { chancesPerFill: d.chancesPerFill, caps: caps as Terms['caps'], prizes: d.prizes };
  }

  /** The seed's commitment, made once: the first touch of a draw makes its seed, before any chance is counted. */
  private async commitment(campaignId: string): Promise<string> {
    const seed = randomBytes(32).toString('hex');
    await this.sql`
      INSERT INTO campaigns.draw_seeds (campaign_id, seed, commitment) VALUES (${campaignId}, ${seed}, ${sha256(seed)})
      ON CONFLICT (campaign_id) DO NOTHING`;
    const [kept] = await this.sql<{ commitment: string }[]>`
      SELECT commitment FROM campaigns.draw_seeds WHERE campaign_id = ${campaignId}`;
    return kept!.commitment;
  }

  /** Every entrant, in join order, with the chances and fills counted. */
  private entrants(campaignId: string): Promise<EntrantRow[]> {
    return this.sql<EntrantRow[]>`
      SELECT p.account_id, p.created_at AS joined_at, COALESCE(sum(c.chances), 0)::int AS chances, count(c.fill_id)::int AS fills
      FROM campaigns.participations p
      LEFT JOIN campaigns.draw_chances c ON c.campaign_id = p.campaign_id AND c.account_id = p.account_id
      WHERE p.campaign_id = ${campaignId}
      GROUP BY p.account_id, p.created_at
      ORDER BY p.created_at ASC, p.account_id ASC`;
  }

  /**
   * Reads one entrant's fills from the venue and counts each new one once, up to the cap for their user type as svc-identity
   * reports it now. Fills from the later of the draw's start and the join, before now, count. A failed read is named,
   * never counted as no activity.
   */
  private async readEntrant(row: DrawRow, terms: Terms, entrant: Pick<EntrantRow, 'account_id' | 'joined_at'>): Promise<void> {
    await this.sql`
      INSERT INTO campaigns.draw_reads (campaign_id, account_id) VALUES (${row.id}, ${entrant.account_id})
      ON CONFLICT DO NOTHING`;
    const unread = (code: string) => this.sql`
      UPDATE campaigns.draw_reads SET unread = ${code} WHERE campaign_id = ${row.id} AND account_id = ${entrant.account_id}`;
    const who = this.participants ? await this.participants.read(entrant.account_id) : null;
    if (!who) {
      await unread('campaigns.participant_unread');
      return;
    }
    const userType = who.kycTier as DrawUserType;
    const cap = terms.caps.find((c) => c.userType === userType)!.cap;
    const since = row.starts_at && row.starts_at > entrant.joined_at ? row.starts_at : entrant.joined_at;
    const answer = this.fills ? await this.fills.ourFills(entrant.account_id, since) : { unread: 'campaigns.fills_unread' };
    if ('unread' in answer) {
      await unread(answer.unread);
      return;
    }
    const now = this.now();
    const counted = answer.fills
      .filter((f) => {
        const at = new Date(f.filledAt);
        return at >= since && at <= now && parseAmount(f.notional) > 0n && parseAmount(f.builderFee) > 0n;
      })
      .sort((a, b) => a.filledAt.localeCompare(b.filledAt) || a.fillId.localeCompare(b.fillId));
    await transaction(this.sql, async (tx) => {
      // One count per entrant at a time, so two reads together never pass the cap.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`campaigns:draw-chances:${row.id}:${entrant.account_id}`}))`;
      const [held] = await tx<{ n: number }[]>`
        SELECT COALESCE(sum(chances), 0)::int AS n FROM campaigns.draw_chances
        WHERE campaign_id = ${row.id} AND account_id = ${entrant.account_id}`;
      let total = held!.n;
      for (const f of counted) {
        const chances = Math.max(0, Math.min(terms.chancesPerFill, cap - total));
        const [kept] = await tx`
          INSERT INTO campaigns.draw_chances (campaign_id, account_id, venue_id, venue_account, fill_id, chances, user_type, filled_at)
          VALUES (${row.id}, ${entrant.account_id}, ${answer.venueId}, ${f.venueAccount}, ${f.fillId}, ${chances}, ${userType},
            ${new Date(f.filledAt)})
          ON CONFLICT (campaign_id, venue_id, venue_account, fill_id) DO NOTHING RETURNING chances`;
        if (kept) total += chances;
      }
      await tx`
        UPDATE campaigns.draw_reads SET read_at = ${new Date(answer.asOf)}, unread = NULL, user_type = ${userType}
        WHERE campaign_id = ${row.id} AND account_id = ${entrant.account_id}`;
    });
  }

  /** One pass over every open draw: each entrant's fills are read and counted. One draw failing never stops the others. */
  async tick(): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM campaigns.campaigns WHERE type = 'draw' AND state IN ('active', 'paused') ORDER BY id LIMIT 100`;
    for (const { id } of rows) {
      try {
        const row = await this.row(id);
        if (!OPEN_STATES.includes(effectiveState(row, this.now()))) continue;
        const terms = this.terms(row);
        await this.commitment(row.id);
        for (const e of await this.entrants(row.id)) await this.readEntrant(row, terms, e);
      } catch (err) {
        this.log('campaigns.draw.tick_failed', { campaignId: id, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * Running or settling a draw (`ops.draw.run`, `ops.draw.settle`): refused `owner.decision` while the owner's decision on
   * chance-based rewards is open, which in this version it always is. The attempt is audited with the operator and their
   * reason; nothing else is written: no seed revealed, no winner, no reward intent.
   */
  async refuseRun(input: { campaignId: string; actor: string; reason: string; action: 'run' | 'settle' }): Promise<never> {
    const row = await this.row(input.campaignId);
    await this.sql`
      INSERT INTO campaigns.audit_log (actor, action, target, detail)
      VALUES (${input.actor}, ${`campaign.draw.${input.action}_refused`}, ${row.id},
        ${this.sql.json({ code: 'owner.decision', reason: input.reason })})`;
    throw new CampaignsError('owner.decision', DRAW_OWNER_QUESTION);
  }

  /** The draw as the caller sees it. While it is open, the caller's own fills are read first, so a trade they just made shows. */
  async board(input: { campaignId: string; accountId: string }): Promise<DrawBoard> {
    const row = await this.row(input.campaignId);
    const terms = this.terms(row);
    const now = this.now();
    const state = effectiveState(row, now);
    const commitment = await this.commitment(row.id);
    const joined = (await this.entrants(row.id)).find((e) => e.account_id === input.accountId);
    if (joined && OPEN_STATES.includes(state)) await this.readEntrant(row, terms, joined);
    const entrants = await this.entrants(row.id);
    const me = entrants.find((e) => e.account_id === input.accountId) ?? null;
    const [read] = me
      ? await this.sql<{ user_type: DrawUserType | null; read_at: Date | null; unread: string | null }[]>`
          SELECT user_type, read_at, unread FROM campaigns.draw_reads WHERE campaign_id = ${row.id} AND account_id = ${input.accountId}`
      : [];
    const userType = read?.user_type ?? null;
    const cap = userType ? terms.caps.find((c) => c.userType === userType)!.cap : null;
    const entries = entrants.map((e) => ({ entrant: entrantOf(e.account_id), chances: e.chances }));
    return {
      campaignId: row.id,
      prizeAsset: row.budget_asset!,
      pool: formatAmount(parseAmount(row.budget_limit!)),
      prizes: terms.prizes,
      chancesPerFill: terms.chancesPerFill,
      caps: terms.caps,
      closesAt: (row.ends_at ?? now).toISOString(),
      closed: CLOSED_STATES.includes(state),
      entrants: entrants.length,
      totalChances: entrants.reduce((n, e) => n + e.chances, 0),
      commitment,
      entryHash: entryHashOf(entries),
      mine: me
        ? {
            joinedAt: me.joined_at.toISOString(),
            userType,
            cap,
            chances: me.chances,
            fills: me.fills,
            capped: cap !== null && me.chances >= cap,
          }
        : null,
      running: { code: 'owner.decision', question: DRAW_OWNER_QUESTION },
      revealed: null,
      winners: [],
      asOf: read?.read_at ? read.read_at.toISOString() : null,
      unread: read?.unread ?? null,
    };
  }
}
