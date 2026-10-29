'use client';

import { useState } from 'react';
import {
  RULE_FIXTURES,
  type CampaignRule,
  type RuleCondition,
  type RuleGroup,
  type RuleLibraryEntry,
  type RuleNode,
  type RuleTestResult,
} from '@intafaced/contracts/campaigns-catalogue';
import { fetchRuleLibrary, postRuleAction, type RuleAnswer } from '@/lib/campaigns-ops/builder-browser';
import {
  addCondition,
  addGroup,
  conditionText,
  emptyRule,
  groupAt,
  placeName,
  placeAfterRemove,
  removeAt,
  setCondition,
  setOp,
  type Place,
} from '@/lib/campaigns-ops/rule-tree';
import { parseRegions } from '@/lib/campaigns-ops/builder-model';

/**
 * THE RULES TAB (CM-eligibility-rules-02, J-campaigns-16 #4).
 *
 * The founder builds AND and OR groups of conditions on what svc-identity knows of an account, tries the rule on a TEST
 * fixture account (every failing condition is listed; nothing is read or stored), saves it to the rule library as that
 * name's next revision, and puts a library revision on the campaign, where every join is checked by it. The owner's
 * depth and size limits are the service's: a blank limit refuses by name.
 */

export type RuleNotice =
  { kind: 'done'; text: string } | { kind: 'refused'; title: string; body: string; next: string; code: string | null };

const refusal = (answer: Extract<RuleAnswer<unknown>, { ok: false }>): RuleNotice => ({
  kind: 'refused',
  title: answer.title,
  body: answer.body,
  next: answer.next,
  code: answer.code,
});

function ConditionEditor({
  condition,
  name,
  onChange,
  onRemove,
}: {
  condition: RuleCondition;
  name: string;
  onChange: (c: RuleCondition) => void;
  onRemove: () => void;
}) {
  const [regions, setRegions] = useState(condition.field === 'region' ? condition.regions.join(', ') : '');
  const field = (value: string) => {
    if (value === 'accountType') onChange({ kind: 'condition', field: 'accountType', is: 'individual' });
    if (value === 'region') onChange({ kind: 'condition', field: 'region', test: 'not_in', regions: ['KP'] });
    if (value === 'kycTier') onChange({ kind: 'condition', field: 'kycTier', atLeast: 'basic' });
    if (value === 'status') onChange({ kind: 'condition', field: 'status', is: 'active' });
  };
  return (
    <li data-testid="rule-condition" data-place={name}>
      <span className="dk-muted">{name}</span>{' '}
      <select aria-label={`Field of condition ${name}`} value={condition.field} onChange={(e) => field(e.target.value)}>
        <option value="accountType">Account type</option>
        <option value="region">Region</option>
        <option value="kycTier">Verification</option>
        <option value="status">Account status</option>
      </select>{' '}
      {condition.field === 'accountType' && (
        <select
          aria-label={`Account type of condition ${name}`}
          value={condition.is}
          onChange={(e) => onChange({ ...condition, is: e.target.value as 'individual' | 'business' })}
        >
          <option value="individual">is individual</option>
          <option value="business">is business</option>
        </select>
      )}
      {condition.field === 'region' && (
        <>
          <select
            aria-label={`Region test of condition ${name}`}
            value={condition.test}
            onChange={(e) => onChange({ ...condition, test: e.target.value as 'in' | 'not_in' })}
          >
            <option value="not_in">is not one of</option>
            <option value="in">is one of</option>
          </select>{' '}
          <input
            aria-label={`Regions of condition ${name}`}
            value={regions}
            onChange={(e) => {
              setRegions(e.target.value);
              const parsed = parseRegions(e.target.value);
              if (parsed.ok && parsed.regions.length > 0) onChange({ ...condition, regions: parsed.regions });
            }}
          />
        </>
      )}
      {condition.field === 'kycTier' && (
        <select
          aria-label={`Verification of condition ${name}`}
          value={condition.atLeast}
          onChange={(e) => onChange({ ...condition, atLeast: e.target.value as 'none' | 'basic' | 'full' | 'institutional' })}
        >
          <option value="none">at least not verified</option>
          <option value="basic">at least basic</option>
          <option value="full">at least full</option>
          <option value="institutional">at least institutional</option>
        </select>
      )}
      {condition.field === 'status' && (
        <select
          aria-label={`Account status of condition ${name}`}
          value={condition.is}
          onChange={(e) => onChange({ ...condition, is: e.target.value as 'active' | 'frozen' | 'closed' })}
        >
          <option value="active">is active</option>
          <option value="frozen">is frozen</option>
          <option value="closed">is closed</option>
        </select>
      )}{' '}
      <button type="button" className="adm-btn" onClick={onRemove}>
        Remove condition {name}
      </button>
    </li>
  );
}

function GroupView({
  group,
  place,
  building,
  onBuildHere,
  onChange,
  onRemove,
}: {
  group: RuleGroup;
  place: Place;
  building: Place;
  onBuildHere: (place: Place) => void;
  onChange: (tree: (t: RuleGroup) => RuleGroup) => void;
  onRemove: (place: Place) => void;
}) {
  const name = placeName(place) || 'outer';
  const here = building.join('.') === place.join('.');
  const parts = (
    <ul>
      {group.parts.map((part: RuleNode, i) => {
        const at = [...place, i];
        return part.kind === 'group' ? (
          <li key={placeName(at)}>
            <GroupView group={part} place={at} building={building} onBuildHere={onBuildHere} onChange={onChange} onRemove={onRemove} />
          </li>
        ) : (
          <ConditionEditor
            key={`${placeName(at)}:${part.field}`}
            condition={part}
            name={placeName(at)}
            onChange={(c) => onChange((t) => setCondition(t, at, c))}
            onRemove={() => onRemove(at)}
          />
        );
      })}
      {group.parts.length === 0 && <li className="dk-muted">Nothing yet: add a condition or a group.</li>}
    </ul>
  );
  if (place.length === 0) return parts;
  return (
    <div data-testid="rule-group" data-place={name} data-building={here}>
      <p>
        Group {name}:{' '}
        <select
          aria-label={`Match of group ${name}`}
          value={group.op}
          onChange={(e) => onChange((t) => setOp(t, place, e.target.value as 'and' | 'or'))}
        >
          <option value="and">all of these (AND)</option>
          <option value="or">any of these (OR)</option>
        </select>{' '}
        {here ? (
          <span className="dk-muted">(new parts go here)</span>
        ) : (
          <button type="button" className="adm-btn" onClick={() => onBuildHere(place)}>
            Add to group {name}
          </button>
        )}{' '}
        <button type="button" className="adm-btn" onClick={() => onRemove(place)}>
          Remove group {name}
        </button>
      </p>
      {parts}
    </div>
  );
}

export function RuleBuilder({
  campaignName,
  current,
  disabled,
  onNotice,
  onUse,
}: {
  campaignName: string;
  current: CampaignRule | null;
  disabled: boolean;
  onNotice: (n: RuleNotice) => void;
  onUse: (rule: CampaignRule) => void;
}) {
  const [tree, setTree] = useState<RuleGroup>(current?.tree ?? emptyRule());
  const [building, setBuilding] = useState<Place>([]);
  const [fixture, setFixture] = useState<string>(RULE_FIXTURES[0].id);
  const [result, setResult] = useState<RuleTestResult | null>(null);
  const [name, setName] = useState(current?.name ?? `${campaignName} rule`);
  const [saved, setSaved] = useState<RuleLibraryEntry | null>(null);
  const [library, setLibrary] = useState<readonly RuleLibraryEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const change = (edit: (t: RuleGroup) => RuleGroup) => {
    setTree(edit);
    setResult(null);
    setSaved(null);
  };
  // A removed part shifts the places after it, so where new parts go follows the tree.
  const remove = (place: Place) => {
    change((t) => removeAt(t, place));
    setBuilding((b) => placeAfterRemove(b, place));
  };

  const tryIt = async () => {
    setBusy(true);
    const answer = await postRuleAction<RuleTestResult>({ op: 'rule-test', tree, fixture });
    if (answer.ok) setResult(answer.data);
    else onNotice(refusal(answer));
    setBusy(false);
  };

  const save = async () => {
    setBusy(true);
    const answer = await postRuleAction<RuleLibraryEntry>({ op: 'rule-save', name, tree });
    if (answer.ok) {
      setSaved(answer.data);
      onNotice({ kind: 'done', text: `Saved to the rule library as ${answer.data.name}, revision ${answer.data.revision}.` });
    } else onNotice(refusal(answer));
    setBusy(false);
  };

  const openLibrary = async () => {
    setBusy(true);
    const answer = await fetchRuleLibrary<RuleLibraryEntry[]>();
    if (answer.ok) setLibrary(answer.data);
    else onNotice(refusal(answer));
    setBusy(false);
  };

  return (
    <section aria-label="Campaign rule" data-testid="campaign-rules">
      <p className="dk-muted">
        On the campaign now:{' '}
        {current
          ? `${current.name}, revision ${current.revision}. Every join is checked by it.`
          : 'no rule. Exclusions and the region list still apply.'}
      </p>
      <fieldset className="adm-field" disabled={disabled || busy}>
        <legend>Rule</legend>
        <p className="dk-muted">
          The outer group needs all of its parts (AND). New groups and conditions go into the group marked as being built.
        </p>
        <GroupView group={tree} place={[]} building={building} onBuildHere={setBuilding} onChange={change} onRemove={remove} />
        <div className="dk-row">
          <button type="button" className="adm-btn" onClick={() => change((t) => addCondition(t, building))}>
            Add a condition
          </button>
          <button
            type="button"
            className="adm-btn"
            onClick={() => {
              const next = addGroup(tree, building, 'and');
              change(() => next.tree);
              setBuilding(next.place);
            }}
          >
            Add an AND group
          </button>
          <button
            type="button"
            className="adm-btn"
            onClick={() => {
              const next = addGroup(tree, building, 'or');
              change(() => next.tree);
              setBuilding(next.place);
            }}
          >
            Add an OR group
          </button>
          {building.length > 0 && (
            <button type="button" className="adm-btn" onClick={() => setBuilding(building.slice(0, -1))}>
              Back to the outer group
            </button>
          )}
        </div>
      </fieldset>

      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="rule-fixture">Fixture account</label>
          <select id="rule-fixture" value={fixture} onChange={(e) => setFixture(e.target.value)} disabled={busy}>
            {RULE_FIXTURES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="adm-btn" disabled={busy} onClick={() => void tryIt()}>
          Test on a fixture account
        </button>
      </div>
      {result && (
        <div data-testid="rule-test-result" data-passes={result.passes}>
          <p>
            {result.passes ? 'The rule lets this TEST account take part.' : 'The rule leaves this TEST account out.'} Nothing was read or
            stored.
          </p>
          <ul aria-label="Failing conditions">
            {result.failing.length === 0 ? (
              <li>None: every condition holds for this account.</li>
            ) : (
              result.failing.map((f) => (
                <li key={f.path} data-place={f.path}>
                  {f.path}: {conditionText(f.condition)}
                </li>
              ))
            )}
          </ul>
        </div>
      )}

      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="rule-name">Rule name</label>
          <input id="rule-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </div>
        <button type="button" className="adm-btn" disabled={busy} onClick={() => void save()}>
          Save to the library
        </button>
        <button
          type="button"
          className="adm-btn"
          disabled={busy || disabled || !saved}
          onClick={() => saved && onUse({ name: saved.name, revision: saved.revision, tree: saved.tree })}
        >
          Put this revision on the campaign
        </button>
        <button type="button" className="adm-btn" disabled={busy} onClick={() => void openLibrary()}>
          Open the rule library
        </button>
      </div>
      {library && (
        <section aria-label="Rule library" data-testid="rule-library">
          {library.length === 0 ? (
            <p className="dk-muted">The library holds no rule yet.</p>
          ) : (
            <ul>
              {library.map((entry) => (
                <li key={`${entry.name}:${entry.revision}`}>
                  {entry.name}, revision {entry.revision}{' '}
                  <button
                    type="button"
                    className="adm-btn"
                    onClick={() => {
                      change(() => entry.tree);
                      setName(entry.name);
                      setBuilding([]);
                      setSaved(entry);
                    }}
                  >
                    Open {entry.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
