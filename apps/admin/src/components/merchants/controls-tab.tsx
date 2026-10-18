import type { MerchantControlProfile, PayCap } from '@intafaced/contracts';
import {
  bpsText,
  CAP_HINT,
  CAP_LABEL,
  capLimitText,
  LAYER_LABEL,
  pricingChain,
  ttlText,
  usageMeter,
  type PricingRuleView,
  type TierView,
  type UsageRow,
} from '@/lib/merchants/control-model';
import type { ControlsData } from '@/lib/merchants/loaders';
import type { ChipSpec } from '@/lib/merchants/chips';
import { formatAmount } from '@/lib/merchants/money';
import { formatUtc } from '@/lib/merchants/time';
import { ConfirmChangePanel } from './confirm-change-panel';
import { ControlChangeForm } from './control-change-form';
import { AsOf, Card, FailureState, StateBlock, StatusChip } from './ui';

const NOT_CONFIGURED = 'Not configured: payments refuse';

const sameCaps = (a: readonly PayCap[], b: readonly PayCap[]) => {
  const key = (c: PayCap) => `${c.kind}|${c.kind === 'beneficiaries_per_day' ? '' : c.assetCode}|${c.limit}`;
  return a.length === b.length && [...a.map(key)].sort().join('\n') === [...b.map(key)].sort().join('\n');
};

/** Which sections of this merchant's control profile are missing. Each missing one means money refuses. */
export function missingSections(profile: MerchantControlProfile): string[] {
  return [
    profile.tierId === null ? 'tier' : null,
    profile.caps === null ? 'caps' : null,
    profile.pricing === null ? 'pricing' : null,
    profile.reserve === null ? 'reserve' : null,
  ].filter((x): x is string => x !== null);
}

const COMPLETE: ChipSpec = {
  label: 'fully configured',
  tone: 'live',
  hint: 'Tier, caps, pricing and reserve are all set for this merchant.',
};
const incomplete = (missing: readonly string[]): ChipSpec => ({
  label: 'not fully configured',
  tone: 'warn',
  hint: `Still to configure: ${missing.join(', ')}. Anything that is not configured refuses money movement; it is never a default.`,
});

function usageChip(row: UsageRow): ChipSpec {
  const meter = usageMeter(row);
  if (meter.state === 'unmeasured')
    return {
      label: 'checked per payment',
      tone: 'neutral',
      hint: 'This cap is checked on each payment. There is no running total to show.',
    };
  if (meter.state === 'full')
    return { label: 'at the cap', tone: 'danger', hint: 'All of this cap is used. New activity of this kind is refused until it resets.' };
  if (meter.state === 'near')
    return { label: 'near the cap', tone: 'warn', hint: 'More than 80% of this cap is used. Display label only.' };
  return { label: 'room left', tone: 'live', hint: 'Less than 80% of this cap is used.' };
}

export function ControlsTab({ data, merchantId, here }: { data: ControlsData; merchantId: string; here: string }) {
  const tiers = data.tiers.kind === 'ok' ? data.tiers.data : null;
  const profile = data.profile.kind === 'ok' ? data.profile.data : null;
  const tier = profile && tiers ? (tiers.find((t) => t.id === profile.tierId) ?? null) : null;
  const rules = data.pricing.kind === 'ok' ? data.pricing.data : null;
  const merchantRules = rules ? rules.filter((r) => r.layer === 'merchant') : [];

  return (
    <>
      <Card
        id="in-force"
        title="In force now"
        sub="What the service applies to this merchant today. A section nobody has configured says so: it is never filled with a default."
        actions={
          profile ? (
            <StatusChip spec={missingSections(profile).length === 0 ? COMPLETE : incomplete(missingSections(profile))} />
          ) : undefined
        }
      >
        {data.profile.kind !== 'ok' ? (
          <FailureState failure={data.profile} what="This merchant's controls" retryHref={here} />
        ) : (
          <>
            <AsOf freshness={{ asOf: data.readAt, lagSeconds: 0 }} label="Controls" />
            <ProfileFacts profile={data.profile.data} tier={tier} tiersKnown={tiers !== null} />
          </>
        )}
      </Card>

      <Card
        id="caps"
        title="Caps and usage"
        sub="What this merchant may move, and how much of each cap is used so far. Caps reset at midnight UTC (daily) or on the 1st (monthly)."
      >
        {data.profile.kind === 'ok' && data.profile.data.caps === null ? (
          <StateBlock kind="not_built" title="Caps are not configured: payments refuse">
            This merchant has no caps and its tier does not supply any. Until an owner sets them, new payments and payouts are refused. Set
            caps below, or put the merchant on a tier that has them.
          </StateBlock>
        ) : data.usage.kind !== 'ok' ? (
          <FailureState failure={data.usage} what="Cap usage" retryHref={here} />
        ) : (
          <>
            <AsOf freshness={{ asOf: data.usage.data.asOf, lagSeconds: 0 }} label="Usage" />
            {data.usage.data.rows.length === 0 ? (
              <StateBlock kind="empty" title="No caps to show">
                No cap applies to this merchant, so there is no usage to measure.
              </StateBlock>
            ) : (
              <UsageTable
                rows={data.usage.data.rows}
                source={profile && tier && profile.caps && sameCaps(profile.caps, tier.caps) ? 'tier' : 'merchant'}
              />
            )}
          </>
        )}
      </Card>

      <Card
        id="pricing"
        title="Pricing, layer by layer"
        sub="The most specific layer wins for each asset: this merchant's own rule, then its tier's, then the global one. The one in force is marked."
      >
        {data.pricing.kind !== 'ok' ? (
          <FailureState failure={data.pricing} what="Pricing rules" retryHref={here} />
        ) : (
          <PricingLayers rules={data.pricing.data} unconfigured={data.profile.kind === 'ok' && data.profile.data.pricing === null} />
        )}
      </Card>

      <Card
        id="tier-rules"
        title="Payout approval rules"
        sub="Set by this merchant's tier. They decide when a payout waits for the merchant's own team, and when it also waits for two founders."
      >
        {data.tiers.kind !== 'ok' ? (
          <FailureState failure={data.tiers} what="Tier definitions" retryHref={here} />
        ) : tier === null ? (
          <StateBlock kind="not_built" title="No tier, so no approval rules: payouts refuse">
            {profile && profile.tierId !== null
              ? `The tier "${profile.tierId}" is not in the tier list.`
              : 'This merchant is not on a tier. Until it is, payouts at any size are refused because no approval threshold exists.'}
          </StateBlock>
        ) : (
          <TierRules tier={tier} />
        )}
      </Card>

      <Card id="history" title="Change history" sub="Who changed what, when and why.">
        <ChangeHistory profile={profile} merchantRules={merchantRules} />
      </Card>

      <Card
        id="change"
        title="Change this merchant's controls"
        sub="Every change needs two different founders: you submit it, a second founder confirms it. Nothing takes effect until then."
      >
        {data.profile.kind !== 'ok' ? (
          <StateBlock kind="info" title="Changes are off while the controls cannot be read">
            The form needs this merchant's current values so it can refuse a change made on stale numbers.
          </StateBlock>
        ) : (
          <ControlChangeForm
            merchantId={merchantId}
            profile={data.profile.data}
            tiers={tiers ?? []}
            tiersReadable={tiers !== null}
            merchantRules={merchantRules}
          />
        )}
      </Card>

      <Card id="pending" title="Pending changes" sub="Changes one founder has submitted and another has not yet confirmed.">
        <StateBlock kind="not_built" title="Pending changes are not listed on this tab">
          The service records a pending change, but this tab does not list it or show it to you before you confirm. The founder who
          submitted a change sends you its request (copy button on the waiting screen), and you confirm it below. Payout approvals that are
          waiting are listed on the Approvals tab.
        </StateBlock>
        <div className="mp-mt">
          {profile ? (
            <ConfirmChangePanel merchantId={merchantId} tiers={tiers ?? []} before={profile} />
          ) : (
            <StateBlock kind="info" title="Confirming is off while the controls cannot be read">
              The page needs this merchant’s current values to check the result of a confirm against what you were shown.
            </StateBlock>
          )}
        </div>
      </Card>

      <Card
        id="over-cap"
        title="Captures over a cap"
        sub="A capture is never refused for a cap, because the payer's money has already moved. When one goes over, it is flagged for operators."
      >
        <StateBlock kind="not_built" title="Captures over a cap are not listed on this tab">
          The service writes a row to its control audit for every over-cap capture. This tab does not list or count them; they are in the
          control audit on the Activity and audit page. Nothing is shown here rather than a made-up count.
        </StateBlock>
      </Card>
    </>
  );
}

function ProfileFacts({ profile, tier, tiersKnown }: { profile: MerchantControlProfile; tier: TierView | null; tiersKnown: boolean }) {
  const reserve = profile.reserve;
  return (
    <dl className="mp-kv">
      <div>
        <dt>Tier</dt>
        <dd>
          {profile.tierId === null ? (
            <span className="mp-warn">Not set: payments refuse</span>
          ) : tier ? (
            <>
              <bdi>{tier.name}</bdi> <code className="mp-sub">{tier.id}</code>
            </>
          ) : (
            <>
              <code>{profile.tierId}</code>
              {tiersKnown ? <span className="mp-muted"> (not in the tier list)</span> : null}
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>Archetype</dt>
        <dd>{profile.archetypeId ?? <span className="mp-muted">Not set</span>}</dd>
      </div>
      <div>
        <dt>Caps</dt>
        <dd>
          {profile.caps === null ? (
            <span className="mp-warn">{NOT_CONFIGURED}</span>
          ) : (
            `${profile.caps.length} set${tier && sameCaps(profile.caps, tier.caps) ? ', from the tier' : ', this merchant’s own'}`
          )}
        </dd>
      </div>
      <div>
        <dt>Pricing</dt>
        <dd>
          {profile.pricing === null ? (
            <span className="mp-warn">{NOT_CONFIGURED}</span>
          ) : (
            profile.pricing.map((p) => `${p.assetCode} (${LAYER_LABEL[p.layer].toLowerCase()})`).join(', ')
          )}
        </dd>
      </div>
      <div>
        <dt>Reserve</dt>
        <dd>
          {reserve === null ? (
            <span className="mp-warn">Not configured</span>
          ) : reserve.rollingReserveBps === null || reserve.holdDays === null ? (
            'None: no money is withheld'
          ) : (
            `${bpsText(reserve.rollingReserveBps)} held for ${reserve.holdDays} day${reserve.holdDays === 1 ? '' : 's'}`
          )}
        </dd>
      </div>
      <div>
        <dt>Version</dt>
        <dd className="mp-num">{profile.version}</dd>
      </div>
      <div>
        <dt>Last changed</dt>
        <dd>
          {profile.updatedAt === null ? (
            <span className="mp-muted">Never changed</span>
          ) : (
            <span className="mp-num">{formatUtc(profile.updatedAt)}</span>
          )}
        </dd>
      </div>
    </dl>
  );
}

function UsageTable({ rows, source }: { rows: readonly UsageRow[]; source: 'tier' | 'merchant' }) {
  return (
    <div className="mp-scroll" tabIndex={0} role="region" aria-label="Cap usage table, scrolls sideways on small screens">
      <table className="mp-table mp-table--rows">
        <caption className="mp-visually-hidden">Caps and usage ({source === 'tier' ? 'from the tier' : 'this merchant’s own'})</caption>
        <thead>
          <tr>
            <th scope="col">Cap</th>
            <th scope="col" className="mp-right">
              Limit
            </th>
            <th scope="col" className="mp-right">
              Used
            </th>
            <th scope="col" className="mp-right">
              Left
            </th>
            <th scope="col">Used so far</th>
            <th scope="col">Resets</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const meter = usageMeter(row);
            const unit = row.assetCode ?? '';
            const show = (v: string | null) =>
              v === null ? (
                <span className="mp-muted">—</span>
              ) : (
                <span className="mp-num">
                  {row.kind === 'beneficiaries_per_day' ? v : formatAmount(v)} {unit}
                </span>
              );
            return (
              <tr key={`${row.kind}-${row.assetCode ?? ''}`}>
                <th scope="row" title={CAP_HINT[row.kind]}>
                  {CAP_LABEL[row.kind]}
                  {row.assetCode ? <span className="mp-asset"> {row.assetCode}</span> : null}
                </th>
                <td className="mp-right">{show(row.limit)}</td>
                <td className="mp-right">{show(row.used)}</td>
                <td className="mp-right">{show(row.remaining)}</td>
                <td>
                  <span className="mp-meter" data-state={meter.state}>
                    <span className="mp-meter__bar" aria-hidden="true">
                      <span style={{ width: `${(meter.permille ?? 0) / 10}%` }} />
                    </span>
                    <StatusChip spec={usageChip(row)} />
                  </span>
                </td>
                <td className="mp-num">{row.resetsAt === null ? <span className="mp-muted">—</span> : formatUtc(row.resetsAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function bandsText(rule: PricingRuleView): string {
  return rule.bands
    .map((b) => `from ${formatAmount(b.fromAmount)}: ${bpsText(b.feeBps)}${b.flatFee === null ? '' : ` + ${formatAmount(b.flatFee)} flat`}`)
    .join('; ');
}

function PricingLayers({ rules, unconfigured }: { rules: readonly PricingRuleView[]; unconfigured: boolean }) {
  const chain = pricingChain(rules);
  if (chain.length === 0) {
    return (
      <StateBlock kind="not_built" title="Pricing is not configured: payments refuse">
        {unconfigured
          ? 'No fee rule exists for this merchant, its tier or globally. Nothing is shown rather than a made-up fee. Set this merchant’s pricing below, or ask an owner to set the tier or global layer.'
          : 'No fee rule was returned.'}
      </StateBlock>
    );
  }
  return (
    <div className="mp-scroll" tabIndex={0} role="region" aria-label="Pricing layers table, scrolls sideways on small screens">
      <table className="mp-table mp-table--rows">
        <caption className="mp-visually-hidden">Pricing rules by asset and layer</caption>
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col">Layer</th>
            <th scope="col">Fee bands</th>
            <th scope="col">Spread</th>
            <th scope="col">Fraction kept by</th>
            <th scope="col">Set</th>
          </tr>
        </thead>
        <tbody>
          {chain.flatMap((row) =>
            row.layers.map(({ rule, inForce }, i) => (
              <tr key={rule.ruleId} data-inforce={inForce ? 'true' : 'false'}>
                {i === 0 ? (
                  <th scope="row" rowSpan={row.layers.length}>
                    {row.assetCode}
                  </th>
                ) : null}
                <td>
                  {LAYER_LABEL[rule.layer]}{' '}
                  {inForce ? (
                    <StatusChip
                      spec={{ label: 'in force', tone: 'live', hint: 'This rule is the one applied to payments in this asset.' }}
                    />
                  ) : (
                    <span className="mp-muted">overridden</span>
                  )}
                </td>
                <td>{bandsText(rule)}</td>
                <td className="mp-num">{rule.spreadBps === null ? <span className="mp-muted">none</span> : bpsText(rule.spreadBps)}</td>
                <td>{rule.roundingBeneficiary === 'platform' ? 'Platform' : 'Merchant'}</td>
                <td className="mp-num" title={`Rule version ${rule.version}`}>
                  {formatUtc(rule.createdAt)}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

function thresholdList(list: readonly { assetCode: string; amount: string }[]) {
  return list.length === 0 ? (
    <span className="mp-warn">None: payouts refuse</span>
  ) : (
    list.map((t) => `${formatAmount(t.amount)} ${t.assetCode}`).join(' · ')
  );
}

function TierRules({ tier }: { tier: TierView }) {
  return (
    <dl className="mp-kv">
      <div>
        <dt>Needs the merchant’s second team member from</dt>
        <dd className="mp-num">{thresholdList(tier.approvalThresholds)}</dd>
      </div>
      <div>
        <dt>Also needs two founders from</dt>
        <dd className="mp-num">{thresholdList(tier.founderThresholds)}</dd>
      </div>
      <div>
        <dt>A request stays valid for</dt>
        <dd>{ttlText(tier.approvalTtlSeconds)}</dd>
      </div>
      <div>
        <dt>Merchants on this tier</dt>
        <dd className="mp-num">{tier.merchants}</dd>
      </div>
      <div>
        <dt>Tier version</dt>
        <dd className="mp-num">{tier.version}</dd>
      </div>
      <div>
        <dt>Tier caps</dt>
        <dd className="mp-num">{tier.caps.map((c) => `${CAP_LABEL[c.kind]} ${capLimitText(c)}`).join(' · ')}</dd>
      </div>
    </dl>
  );
}

function ChangeHistory({ profile, merchantRules }: { profile: MerchantControlProfile | null; merchantRules: readonly PricingRuleView[] }) {
  return (
    <>
      <StateBlock kind="not_built" title="Who changed what is on the Activity and audit page">
        Every change is recorded with who made it, who confirmed it, the old and new values and the reason. This tab does not list that
        record; the Activity and audit page does, newest first. Below is only what the current state itself says.
      </StateBlock>
      <dl className="mp-kv mp-mt">
        <div>
          <dt>Version of this merchant’s controls</dt>
          <dd className="mp-num">{profile ? profile.version : <span className="mp-muted">unknown</span>}</dd>
        </div>
        <div>
          <dt>Last change to tier, caps or reserve</dt>
          <dd className="mp-num">
            {profile === null ? (
              <span className="mp-muted">unknown</span>
            ) : profile.updatedAt === null ? (
              <span className="mp-muted">Never changed</span>
            ) : (
              formatUtc(profile.updatedAt)
            )}
          </dd>
        </div>
        <div>
          <dt>This merchant’s own pricing rules</dt>
          <dd>
            {merchantRules.length === 0
              ? 'None'
              : merchantRules.map((r) => `${r.assetCode}, set ${formatUtc(r.createdAt)}, version ${r.version}`).join(' · ')}
          </dd>
        </div>
      </dl>
    </>
  );
}
