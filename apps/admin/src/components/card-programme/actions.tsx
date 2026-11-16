'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { founderMutationHeaders } from '@/lib/founder-browser';
import { refusalWords, type ActionName, type Rule } from '@/lib/card-programme/model';
import '../desk.css';

interface Answer {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly code?: string | null;
  readonly message?: string;
  readonly unknown?: boolean;
}

async function post(action: ActionName, body?: Record<string, unknown>): Promise<Answer> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Your founder session could not be confirmed.' };
  }
  try {
    const res = await fetch('/api/bank-ops/cards', {
      method: 'POST',
      headers,
      body: JSON.stringify(body === undefined ? { action } : { action, body }),
      credentials: 'same-origin',
    });
    return (await res.json()) as Answer;
  } catch {
    return {
      ok: false,
      unknown: true,
      message: 'The answer was lost. Read the desk to see what was stored; nothing is repeated automatically.',
    };
  }
}

/** One step's runner: busy while it runs, the answer in words after, the desk read again on success. */
function useStep(section: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const run = async (action: ActionName, body: Record<string, unknown> | undefined, done: string): Promise<Answer> => {
    setBusy(true);
    const a = await post(action, body);
    setBusy(false);
    if (a.ok) {
      setSaid({ tone: 'ok', text: done });
      router.refresh();
    } else setSaid({ tone: 'warn', text: a.message ?? refusalWords(a.code ?? null) ?? 'svc-bank refused this.' });
    return a;
  };
  const view = said ? (
    <div className="adm-callout" data-tone={said.tone} role="status" data-testid={`cp-answer-${section}`}>
      {said.text}
    </div>
  ) : null;
  const say = (text: string) => setSaid({ tone: 'ok', text });
  return { busy, run, view, say };
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="adm-field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}
function Text({
  id,
  label,
  value,
  set,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  set: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <Field id={id} label={label}>
      <input id={id} className="adm-input" value={value} placeholder={placeholder} onChange={(e) => set(e.target.value)} />
    </Field>
  );
}
function Choice({
  id,
  label,
  value,
  set,
  options,
}: {
  id: string;
  label: string;
  value: string;
  set: (v: string) => void;
  options: ReadonlyArray<[string, string]>;
}) {
  return (
    <Field id={id} label={label}>
      <select id={id} className="adm-input" value={value} onChange={(e) => set(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </Field>
  );
}
const blankIsNull = (v: string) => (v.trim() === '' ? null : v.trim());

export function ConfigForms() {
  const step = useStep('config');
  const [type, setType] = useState('consumer');
  const [currencies, setCurrencies] = useState('USDC');
  const [fulfilment, setFulfilment] = useState('virtual_only');
  const [product, setProduct] = useState('');
  const [cardType, setCardType] = useState('virtual');
  const [productAsset, setProductAsset] = useState('USDC');
  const [limit, setLimit] = useState('');
  const [bin, setBin] = useState('');
  const [network, setNetwork] = useState('');
  const [range, setRange] = useState('shared');
  const [feeAsset, setFeeAsset] = useState('USDC');
  const [issuance, setIssuance] = useState('');
  const [replacement, setReplacement] = useState('');
  const [monthly, setMonthly] = useState('');
  const save = (key: string, value: Record<string, unknown>, what: string) =>
    void step.run('configure', { key, value }, `${what} saved. The audit log has the value before and after.`);
  return (
    <div className="dk-stack" data-testid="cp-config-forms">
      <form
        className="dk-row"
        onSubmit={(e) => (
          e.preventDefault(),
          save(
            'programme',
            {
              type,
              currencies: currencies
                .split(',')
                .map((c) => c.trim().toUpperCase())
                .filter(Boolean),
              fulfilment,
            },
            'The programme',
          )
        )}
      >
        <Choice
          id="cp-programme-type"
          label="Programme type"
          value={type}
          set={setType}
          options={[
            ['consumer', 'Consumer'],
            ['commercial', 'Commercial'],
          ]}
        />
        <Text id="cp-programme-currencies" label="Currencies" value={currencies} set={setCurrencies} />
        <Choice
          id="cp-programme-fulfilment"
          label="Fulfilment"
          value={fulfilment}
          set={setFulfilment}
          options={[
            ['virtual_only', 'Virtual cards only'],
            ['virtual_and_physical', 'Virtual and physical'],
          ]}
        />
        <button type="submit" className="adm-btn" disabled={step.busy}>
          Save programme
        </button>
      </form>
      <form
        className="dk-row"
        onSubmit={(e) => (
          e.preventDefault(),
          save(
            'product',
            { name: product.trim(), cardType, assetId: productAsset.trim().toUpperCase(), perAuthorizationLimit: limit.trim() },
            'The product',
          )
        )}
      >
        <Text id="cp-product-name" label="Product name" value={product} set={setProduct} />
        <Choice
          id="cp-product-type"
          label="Card type"
          value={cardType}
          set={setCardType}
          options={[
            ['virtual', 'Virtual'],
            ['physical', 'Physical'],
          ]}
        />
        <Text id="cp-product-asset" label="Product asset" value={productAsset} set={setProductAsset} />
        <Text id="cp-product-limit" label="Per-payment limit" value={limit} set={setLimit} />
        <button type="submit" className="adm-btn" disabled={step.busy}>
          Save product
        </button>
      </form>
      <form
        className="dk-row"
        onSubmit={(e) => (e.preventDefault(), save('bin', { bin: bin.trim(), network: network.trim(), range }, 'The BIN'))}
      >
        <Text id="cp-bin" label="BIN" value={bin} set={setBin} />
        <Text id="cp-bin-network" label="Network" value={network} set={setNetwork} />
        <Choice
          id="cp-bin-range"
          label="BIN range"
          value={range}
          set={setRange}
          options={[
            ['shared', 'Shared BIN'],
            ['dedicated', 'Dedicated range'],
          ]}
        />
        <button type="submit" className="adm-btn" disabled={step.busy}>
          Save BIN
        </button>
      </form>
      <form
        className="dk-row"
        onSubmit={(e) => (
          e.preventDefault(),
          save(
            'fees',
            {
              assetId: feeAsset.trim().toUpperCase(),
              issuance: blankIsNull(issuance),
              replacement: blankIsNull(replacement),
              monthly: blankIsNull(monthly),
            },
            'The cardholder fees',
          )
        )}
      >
        <Text id="cp-fee-asset" label="Fee asset" value={feeAsset} set={setFeeAsset} />
        <Text id="cp-fee-issuance" label="Issuance fee" value={issuance} set={setIssuance} placeholder="blank: not set" />
        <Text id="cp-fee-replacement" label="Replacement fee" value={replacement} set={setReplacement} placeholder="blank: not set" />
        <Text id="cp-fee-monthly" label="Monthly fee" value={monthly} set={setMonthly} placeholder="blank: not set" />
        <button type="submit" className="adm-btn" disabled={step.busy}>
          Save fees
        </button>
      </form>
      {step.view}
    </div>
  );
}

export function RuleForms({ rules }: { rules: readonly Rule[] }) {
  const step = useStep('rules');
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('merchant_category');
  const [value, setValue] = useState('');
  const [asset, setAsset] = useState('USDC');
  const params = () =>
    kind === 'amount_above'
      ? { kind, assetId: asset.trim().toUpperCase(), amount: value.trim() }
      : kind === 'channel'
        ? { kind, channel: value.trim() }
        : { kind, category: value.trim() };
  const activeKeys = new Set(rules.filter((r) => r.state === 'active').map((r) => r.ruleKey));
  return (
    <div className="dk-stack" data-testid="cp-rule-forms">
      <form
        className="dk-row"
        onSubmit={(e) => {
          e.preventDefault();
          void step.run(
            'ruleCreate',
            { ruleKey: key.trim(), name: name.trim(), params: params() },
            'The rule runs in shadow: it decides nothing until promoted.',
          );
        }}
      >
        <Text id="cp-rule-key" label="Rule key" value={key} set={setKey} />
        <Text id="cp-rule-name" label="Rule name" value={name} set={setName} />
        <Choice
          id="cp-rule-kind"
          label="Declines"
          value={kind}
          set={setKind}
          options={[
            ['merchant_category', 'A merchant category'],
            ['channel', 'A channel'],
            ['amount_above', 'A payment above an amount'],
          ]}
        />
        <Text id="cp-rule-value" label="Category, channel or amount" value={value} set={setValue} />
        {kind === 'amount_above' && <Text id="cp-rule-asset" label="Rule asset" value={asset} set={setAsset} />}
        <button type="submit" className="adm-btn" disabled={step.busy}>
          Run in shadow
        </button>
      </form>
      <div className="dk-row">
        {rules
          .filter((r) => r.state === 'shadow')
          .map((r) => (
            <button
              key={r.id}
              type="button"
              className="adm-btn"
              disabled={step.busy}
              onClick={() =>
                void step.run('rulePromote', { ruleId: r.id }, `${r.name} version ${r.version} decides new authorisations from now.`)
              }
            >
              Promote {r.ruleKey} v{r.version}
            </button>
          ))}
        {[...activeKeys].map((k) => (
          <button
            key={k}
            type="button"
            className="adm-btn"
            disabled={step.busy}
            onClick={() => void step.run('ruleRollback', { ruleKey: k }, `${k} rolled back. Past decisions are unchanged.`)}
          >
            Roll back {k}
          </button>
        ))}
      </div>
      {step.view}
    </div>
  );
}

export function ThreeDsForm() {
  const step = useStep('threeds');
  const [mode, setMode] = useState('challenge_all');
  const [limit, setLimit] = useState('');
  const [asset, setAsset] = useState('USDC');
  return (
    <div className="dk-stack">
      <form
        className="dk-row"
        onSubmit={(e) => {
          e.preventDefault();
          const lowValueExemption = limit.trim() === '' ? null : { assetId: asset.trim().toUpperCase(), limit: limit.trim() };
          void step.run(
            'configure',
            { key: 'threeds', value: { mode, lowValueExemption } },
            'The 3DS policy is saved. It decides new online payments.',
          );
        }}
      >
        <Choice
          id="cp-3ds-mode"
          label="3DS policy"
          value={mode}
          set={setMode}
          options={[
            ['challenge_all', 'Challenge every online payment'],
            ['frictionless', 'Frictionless'],
          ]}
        />
        <Text id="cp-3ds-limit" label="SCA exemption limit" value={limit} set={setLimit} placeholder="blank: no exemption" />
        <Text id="cp-3ds-asset" label="Exemption asset" value={asset} set={setAsset} />
        <button type="submit" className="adm-btn" disabled={step.busy}>
          Save 3DS policy
        </button>
      </form>
      <button
        type="button"
        className="adm-btn"
        disabled={step.busy}
        onClick={() => void step.run('clearThreeDs', undefined, 'The 3DS policy is cleared.')}
      >
        Clear 3DS policy
      </button>
      {step.view}
    </div>
  );
}

export function CardholderForm() {
  const step = useStep('cardholder');
  const [requestKey, setRequestKey] = useState(() => `console-cardholder-${crypto.randomUUID()}`);
  const [kind, setKind] = useState('individual');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState('NL');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  return (
    <form
      className="dk-stack"
      data-testid="cp-cardholder-form"
      onSubmit={(e) => {
        e.preventDefault();
        const body: Record<string, unknown> = { requestKey, kind, name: name.trim(), country: country.trim().toUpperCase() };
        if (kind === 'individual') body.email = email.trim();
        else body.beneficialOwners = ownerName.trim() === '' ? [] : [{ name: ownerName.trim(), email: ownerEmail.trim() }];
        void step.run('cardholderCreate', body, 'The cardholder passed the gate and screening.').then((a) => {
          // A stored answer (verified or queued) is final for this key; the next cardholder gets a new one.
          if (a.ok || a.code === 'bank.cardholder_unverified' || a.code === 'bank.cardholder_under_review')
            setRequestKey(`console-cardholder-${crypto.randomUUID()}`);
        });
      }}
    >
      <div className="dk-row">
        <Choice
          id="cp-ch-kind"
          label="Cardholder type"
          value={kind}
          set={setKind}
          options={[
            ['individual', 'Individual (KYC)'],
            ['business', 'Business (KYB)'],
          ]}
        />
        <Text id="cp-ch-name" label="Cardholder name" value={name} set={setName} />
        {kind === 'individual' ? (
          <Text id="cp-ch-email" label="Cardholder email" value={email} set={setEmail} />
        ) : (
          <>
            <Text
              id="cp-ch-owner-name"
              label="Beneficial owner name"
              value={ownerName}
              set={setOwnerName}
              placeholder="blank: none on file"
            />
            <Text id="cp-ch-owner-email" label="Beneficial owner email" value={ownerEmail} set={setOwnerEmail} />
          </>
        )}
        <Text id="cp-ch-country" label="Country" value={country} set={setCountry} />
        <button type="submit" className="adm-btn" disabled={step.busy}>
          Create cardholder
        </button>
      </div>
      {step.view}
    </form>
  );
}

export function StaffForm() {
  const step = useStep('staff');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  return (
    <form
      className="dk-row"
      onSubmit={(e) => (
        e.preventDefault(),
        void step.run('staffAssign', { email: email.trim(), role }, 'The role is given. The audit log lists it.')
      )}
    >
      <Text id="cp-staff-email" label="Staff email" value={email} set={setEmail} />
      <Choice
        id="cp-staff-role"
        label="Role"
        value={role}
        set={setRole}
        options={[
          ['viewer', 'Viewer (reads only)'],
          ['manager', 'Manager'],
        ]}
      />
      <button type="submit" className="adm-btn" disabled={step.busy}>
        Give role
      </button>
      {step.view}
    </form>
  );
}

export function ExportButton() {
  const step = useStep('export');
  const [file, setFile] = useState<{ text: string; asOf: string; sha256: string; signature: string; fileName: string } | null>(null);
  return (
    <div className="dk-stack">
      <button
        type="button"
        className="adm-btn"
        disabled={step.busy}
        onClick={() =>
          void step.run('export', undefined, 'The report is exported and signed.').then((a) => {
            if (a.ok) setFile(a.data as typeof file);
          })
        }
      >
        Export signed report
      </button>
      {step.view}
      {file && (
        <div className="dk-stack" data-testid="cp-export">
          <p>
            {file.fileName} · freshness <span data-testid="cp-export-asof">{file.asOf}</span>
          </p>
          <pre data-testid="cp-export-file">{file.text}</pre>
          <p className="dk-muted">
            SHA-256 <code data-testid="cp-export-sha">{file.sha256}</code> · signature{' '}
            <code data-testid="cp-export-signature">{file.signature}</code>
          </p>
        </div>
      )}
    </div>
  );
}

export function BulkForm() {
  const step = useStep('bulk');
  const [file, setFile] = useState('');
  const [rows, setRows] = useState<Array<{ row: number; cardholderId: string; error: string | null }> | null>(null);
  const [issued, setIssued] = useState<{ cardsInBatch: number; cards: Array<{ row: number; panTail: string }> } | null>(null);
  return (
    <div className="dk-stack" data-testid="cp-bulk-form">
      <Field id="cp-bulk-file" label="Bulk file (cardholder id, asset, per-authorisation limit)">
        <textarea id="cp-bulk-file" className="adm-input" rows={6} value={file} onChange={(e) => setFile(e.target.value)} />
      </Field>
      <div className="dk-row">
        <button
          type="button"
          className="adm-btn"
          disabled={step.busy}
          onClick={() =>
            void step.run('bulkValidate', { file }, 'The file is checked.').then((a) => {
              if (a.ok) setRows((a.data as { rows: typeof rows }).rows);
            })
          }
        >
          Check file
        </button>
        <button
          type="button"
          className="adm-btn"
          disabled={step.busy}
          onClick={() =>
            void step.run('bulkIssue', { file }, 'The cards are issued.').then((a) => {
              setIssued(a.ok ? (a.data as typeof issued) : null);
            })
          }
        >
          Issue cards
        </button>
      </div>
      {step.view}
      {rows && (
        <div className="dk-table-wrap">
          <table className="adm-table" data-testid="cp-bulk-rows">
            <thead>
              <tr>
                <th>Row</th>
                <th>Cardholder</th>
                <th>Check</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.row} data-bad={r.error ? 'true' : 'false'}>
                  <td>{r.row}</td>
                  <td>{r.cardholderId}</td>
                  <td>{r.error ?? 'ok'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {issued && (
        <p data-testid="cp-bulk-issued">
          {issued.cardsInBatch} cards in this file: {issued.cards.map((c) => `row ${c.row} ending ${c.panTail}`).join(', ')}.
        </p>
      )}
    </div>
  );
}

export function ReassignForm() {
  const step = useStep('reassign');
  const [cardId, setCardId] = useState('');
  const [to, setTo] = useState('');
  return (
    <form
      className="dk-row"
      onSubmit={(e) => (
        e.preventDefault(),
        void step.run('reassign', { cardId: cardId.trim(), toCardholderId: to.trim() }, 'The card is reassigned. No money moved.')
      )}
    >
      <Text id="cp-reassign-card" label="Card id" value={cardId} set={setCardId} />
      <Text id="cp-reassign-to" label="To cardholder id" value={to} set={setTo} />
      <button type="submit" className="adm-btn" disabled={step.busy}>
        Reassign card
      </button>
      {step.view}
    </form>
  );
}

export function SimulatorForm() {
  const step = useStep('simulator');
  const [cardId, setCardId] = useState('');
  const [kind, setKind] = useState('authorize');
  const [ref, setRef] = useState(() => `TEST-sim-${crypto.randomUUID().slice(0, 8)}`);
  const [amount, setAmount] = useState('');
  const [channel, setChannel] = useState('card-present');
  const [category, setCategory] = useState('');
  const [threeDs, setThreeDs] = useState('');
  return (
    <form
      className="dk-stack"
      data-testid="cp-simulator-form"
      onSubmit={(e) => {
        e.preventDefault();
        const body: Record<string, unknown> = { kind, cardId: cardId.trim(), authorizationRef: ref.trim() };
        if (kind !== 'reverse') body.amount = amount.trim();
        if (kind === 'authorize') {
          body.channel = channel;
          if (category.trim()) body.merchantCategory = category.trim();
          if (threeDs) body.threeDs = threeDs;
        }
        void step.run('simulate', body, 'TEST event sent').then((a) => {
          if (a.ok) {
            const d = a.data as { decision?: string; declineCode?: string | null; captured?: string; returned?: string };
            const words = d.decision
              ? `TEST: ${d.decision}${d.declineCode ? ` (${d.declineCode})` : ''}`
              : `TEST: captured ${d.captured ?? '0'}, given back ${d.returned ?? '0'}`;
            step.say(words);
          }
        });
      }}
    >
      <div className="dk-row">
        <Text id="cp-sim-card" label="Simulated card id" value={cardId} set={setCardId} />
        <Choice
          id="cp-sim-kind"
          label="Event"
          value={kind}
          set={setKind}
          options={[
            ['authorize', 'Authorisation'],
            ['capture', 'Capture'],
            ['reverse', 'Reversal'],
          ]}
        />
        <Text id="cp-sim-ref" label="Authorisation reference" value={ref} set={setRef} />
        {kind !== 'reverse' && <Text id="cp-sim-amount" label="Event amount" value={amount} set={setAmount} />}
        {kind === 'authorize' && (
          <>
            <Choice
              id="cp-sim-channel"
              label="Event channel"
              value={channel}
              set={setChannel}
              options={[
                ['card-present', 'Card present'],
                ['online', 'Online'],
                ['contactless', 'Contactless'],
                ['atm', 'ATM'],
                ['foreign', 'Abroad'],
              ]}
            />
            <Text id="cp-sim-category" label="Merchant category" value={category} set={setCategory} />
            <Choice
              id="cp-sim-3ds"
              label="3DS challenge"
              value={threeDs}
              set={setThreeDs}
              options={[
                ['', 'None done'],
                ['authenticated', 'Passed'],
                ['failed', 'Failed'],
              ]}
            />
          </>
        )}
        <button type="submit" className="adm-btn" disabled={step.busy}>
          Send TEST event
        </button>
      </div>
      {step.view}
    </form>
  );
}
