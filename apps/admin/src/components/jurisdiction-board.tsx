'use client';

import { useMemo, useState } from 'react';
import { Panel, StatBlock } from '@intafaced/ui';
import {
  DEFAULT_MODULE_RULES,
  JURISDICTION_MATRIX,
  KYC_TIERS,
  MODULES,
  MODULE_IDS,
  PLANES,
  assertReviewed,
  checkAccess,
  regionsWithEntries,
  type JurisdictionEntry,
  type JurisdictionRule,
  type KycTier,
  type ModuleId,
  type Plane,
} from '@intafaced/config';
import { Chip, type ChipTone } from '@/components/chip';
import { formatWhen } from '@/lib/as-of';

/**
 * JURISDICTION MATRIX — §3, §9, §22.
 *
 * The matrix is read straight out of `@intafaced/config`; this screen holds no
 * geo data of its own. Two things it is built to make impossible to miss:
 *
 *  1. Which entries carry no `reviewedBy`. `assertReviewed()` refuses to let an
 *     unreviewed region become a launch market, and shipping a market that
 *     counsel has not signed is the actual risk on this page — bigger than any
 *     individual rule being wrong.
 *  2. What `checkAccess()` decides for a concrete (module, region, plane, tier),
 *     using the same function every service calls before serving a user.
 */

const STATUS_TONE: Readonly<Record<JurisdictionRule['status'], ChipTone>> = {
  open: 'live',
  restricted: 'warn',
  blocked: 'danger',
};

/**
 * `ruleFor()` is private to jurisdiction.ts, so the effective rule is composed
 * here from the two exported halves. This is the one derivation in the console
 * that mirrors package-internal logic — see the README's notes on the config
 * package for why it should be exported instead.
 */
function effectiveRule(entry: JurisdictionEntry | undefined, module: ModuleId): { rule: JurisdictionRule; explicit: boolean } {
  const override = entry?.modules?.[module];
  return override ? { rule: override, explicit: true } : { rule: DEFAULT_MODULE_RULES[module], explicit: false };
}

function isReviewed(entry: JurisdictionEntry): boolean {
  return Boolean(entry.reviewedBy && entry.reviewedAt);
}

export function JurisdictionBoard() {
  const entries = JURISDICTION_MATRIX;
  const namedRegions = useMemo(() => regionsWithEntries(), []);
  const unreviewed = entries.filter((entry) => !isReviewed(entry));

  const reviewError = useMemo(() => {
    try {
      assertReviewed(namedRegions);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [namedRegions]);

  return (
    <>
      <div className="adm-pagehead">
        <div>
          <h1>Jurisdiction matrix</h1>
          <p>
            Every module checks this matrix before serving a user; launch markets are a toggle, not a refactor (§9). The seed entries are a
            structure, not legal advice — each <code>status</code> and <code>minTier</code> needs counsel sign-off before the market is
            switched on.
          </p>
          <p>
            <strong>Compiled policy, not live state.</strong> This matrix is read from <code>@intafaced/config</code> as built into this
            console. What the running edge reports right now is in the live section above.
          </p>
        </div>
      </div>

      <Panel title="Counsel review" className={unreviewed.length > 0 ? 'adm-panel--danger' : undefined} live={unreviewed.length === 0}>
        <div className="adm-stack">
          <div className="adm-statrow">
            <StatBlock label="Entries" value={entries.length} />
            <StatBlock label="Signed by counsel" value={`${entries.length - unreviewed.length} / ${entries.length}`} />
            <StatBlock label="Named markets" value={namedRegions.length} deltaLabel="excluding the * default" />
            <StatBlock label="Launch-eligible" value={reviewError === null ? namedRegions.length : 0} />
          </div>

          {reviewError !== null && (
            <div className="adm-callout" data-tone="danger">
              <strong>assertReviewed() would throw for every named market</strong>
              <code>{reviewError}</code>
            </div>
          )}

          <div className="adm-scroll">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Region</th>
                  <th>Reviewed by</th>
                  <th>Reviewed at</th>
                  <th className="adm-num">Module overrides</th>
                  <th>Region-wide block</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const signed = isReviewed(entry);
                  const overrideCount = Object.keys(entry.modules ?? {}).length;
                  return (
                    <tr key={entry.region} data-unreviewed={!signed}>
                      <td className="adm-key">{entry.region === '*' ? '* (default)' : entry.region}</td>
                      <td className="adm-desc">{entry.reviewedBy ?? '— not signed —'}</td>
                      <td className="adm-desc">{entry.reviewedAt ? formatWhen(entry.reviewedAt) : '—'}</td>
                      <td className="adm-num">{overrideCount}</td>
                      <td>{entry.blocked ? <Chip tone="danger">Blocked</Chip> : <Chip tone="dark">No</Chip>}</td>
                      <td>
                        {signed ? (
                          <Chip tone="live" dot>
                            Signed
                          </Chip>
                        ) : (
                          <Chip tone="danger" dot>
                            Unreviewed
                          </Chip>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="adm-footnote">
            An unreviewed row is not a formatting problem. It means the rule below it was written by an engineer as a placeholder, and
            enabling that market ships an untested legal position. The <code>*</code> default row is the one every unlisted country falls
            back to, so it is the widest-blast-radius entry in the table.
          </p>
        </div>
      </Panel>

      <Panel title="Effective rules — module × region" className="adm-flush">
        <div className="adm-scroll">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Module</th>
                <th>Planes</th>
                <th>Custody</th>
                <th>Default (*)</th>
                {namedRegions.map((region) => (
                  <th key={region}>{region}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MODULE_IDS.map((module) => {
                const def = MODULES[module];
                const fallback = DEFAULT_MODULE_RULES[module];
                return (
                  <tr key={module}>
                    <td className="adm-key">{module}</td>
                    <td className="adm-desc">{def.planes.join(' + ')}</td>
                    <td>{def.custodial ? <Chip tone="warn">Custodial</Chip> : <Chip tone="info">None</Chip>}</td>
                    <td>
                      <RuleCell rule={fallback} explicit={false} />
                    </td>
                    {namedRegions.map((region) => {
                      const entry = entries.find((candidate) => candidate.region === region);
                      const { rule, explicit } = effectiveRule(entry, module);
                      return (
                        <td key={region}>
                          <RuleCell rule={rule} explicit={explicit} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <DecisionPanel knownRegions={namedRegions} />
    </>
  );
}

function RuleCell({ rule, explicit }: { rule: JurisdictionRule; explicit: boolean }) {
  return (
    <span className="adm-inline" title={rule.notes ?? undefined}>
      <Chip tone={STATUS_TONE[rule.status]}>{rule.status}</Chip>
      <span className="adm-key">{rule.minTier}</span>
      {rule.limitMultiplier !== undefined && rule.limitMultiplier !== 1 && <Chip tone="warn">×{rule.limitMultiplier}</Chip>}
      {explicit && <Chip tone="info">override</Chip>}
    </span>
  );
}

// ── Live decision ───────────────────────────────────────────────────────────

const DECISION_TONE: Readonly<Record<string, ChipTone>> = {
  allowed: 'live',
  'allowed.permissionless': 'live',
  'denied.region_blocked': 'danger',
  'denied.module_blocked': 'danger',
  'denied.kyc_required': 'warn',
  'denied.plane_unsupported': 'dark',
};

function DecisionPanel({ knownRegions }: { knownRegions: readonly string[] }) {
  const [module, setModule] = useState<ModuleId>('trade');
  const [region, setRegion] = useState('GB');
  const [plane, setPlane] = useState<Plane>('fiat');
  const [kycTier, setKycTier] = useState<KycTier>('basic');

  const decision = useMemo(() => checkAccess({ module, region, plane, kycTier }), [module, region, plane, kycTier]);
  const tone = DECISION_TONE[decision.code] ?? 'neutral';

  return (
    <Panel title="Live decision — checkAccess()" live={decision.allowed}>
      <div className="adm-split">
        <div className="adm-stack">
          <div className="adm-cols">
            <div className="adm-field">
              <label htmlFor="decision-module">Module</label>
              <select
                id="decision-module"
                className="adm-select"
                value={module}
                onChange={(event) => setModule(event.target.value as ModuleId)}
              >
                {MODULE_IDS.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>

            <div className="adm-field">
              <label htmlFor="decision-region">Region (ISO-3166 alpha-2)</label>
              <input
                id="decision-region"
                className="adm-input"
                list="known-regions"
                value={region}
                maxLength={2}
                onChange={(event) => setRegion(event.target.value.toUpperCase())}
              />
              <datalist id="known-regions">
                {knownRegions.map((code) => (
                  <option key={code} value={code} />
                ))}
              </datalist>
            </div>

            <div className="adm-field">
              <label htmlFor="decision-plane">Plane</label>
              <select id="decision-plane" className="adm-select" value={plane} onChange={(event) => setPlane(event.target.value as Plane)}>
                {PLANES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>

            <div className="adm-field">
              <label htmlFor="decision-tier">Held KYC tier</label>
              <select
                id="decision-tier"
                className="adm-select"
                value={kycTier}
                onChange={(event) => setKycTier(event.target.value as KycTier)}
              >
                {KYC_TIERS.map((tier) => (
                  <option key={tier} value={tier}>
                    {tier}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="adm-footnote">
            A region with no entry falls through to the <code>*</code> default — type any code to see it. §22: on the protocol plane a
            non-custodial module returns <code>allowed.permissionless</code> without ever reading a tier, because the platform never holds
            the asset.
          </p>
        </div>

        <div className="adm-stack">
          <div className="adm-inline">
            <Chip tone={tone} dot>
              {decision.allowed ? 'Allowed' : 'Denied'}
            </Chip>
            <Chip tone={tone}>{decision.code}</Chip>
          </div>

          <dl className="adm-kv">
            <dt>Status</dt>
            <dd>{decision.status}</dd>
            <dt>Required tier</dt>
            <dd>{decision.requiredTier ?? '—'}</dd>
            <dt>Limit ×</dt>
            <dd>{decision.limitMultiplier}</dd>
            <dt>Custody</dt>
            <dd>{MODULES[module].custodial ? 'custodial' : 'non-custodial'}</dd>
            <dt>Reason</dt>
            <dd>{decision.reason}</dd>
          </dl>
        </div>
      </div>
    </Panel>
  );
}
