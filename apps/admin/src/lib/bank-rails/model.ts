/**
 * The founders' bank rails desk (J-bank-30 #8): salary paid in by direct deposit, per currency, the payroll network's own
 * credits minus reversals against what the app showed, through svc-bank (`ops.salaryRails`). A shape this console does not
 * understand is refused whole, never guessed at. Pure, so the server loader and its tests share it.
 */
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): v is string => typeof v === 'string';
const DECIMAL = /^-?\d+(\.\d+)?$/;
const dec = (v: unknown): v is string => str(v) && DECIMAL.test(v);

export interface RailFigures {
  readonly credits: string;
  readonly reversals: string;
}

export interface SalaryRailLine {
  readonly currency: string;
  /** The network's own word; null when it keeps no record ("not known", never zero). */
  readonly network: RailFigures | null;
  readonly app: RailFigures;
  readonly matches: boolean | null;
  readonly difference: string | null;
}

export interface SalaryRails {
  readonly label: string;
  readonly asOf: string;
  readonly lines: readonly SalaryRailLine[];
}

const figures = (v: unknown): RailFigures | null => {
  const r = rec(v);
  return r && dec(r.credits) && dec(r.reversals) ? { credits: r.credits, reversals: r.reversals } : null;
};

export function parseSalaryRails(raw: unknown): { partner: SalaryRails | null } | null {
  const r = rec(raw);
  if (!r || !('partner' in r)) return null;
  if (r.partner === null) return { partner: null };
  const p = rec(r.partner);
  if (!p || !str(p.label) || !str(p.asOf) || !Array.isArray(p.lines)) return null;
  const lines: SalaryRailLine[] = [];
  for (const x of p.lines) {
    const l = rec(x);
    if (!l || !str(l.currency)) return null;
    const app = figures(l.app);
    const network = l.network === null ? null : figures(l.network);
    if (!app || (l.network !== null && !network)) return null;
    if (!(l.matches === null || typeof l.matches === 'boolean')) return null;
    if (!(l.difference === null || dec(l.difference))) return null;
    if ((network === null) !== (l.matches === null) || (l.matches === null) !== (l.difference === null)) return null;
    lines.push({ currency: l.currency, network, app, matches: l.matches, difference: l.difference });
  }
  return { partner: { label: p.label, asOf: p.asOf, lines } };
}
