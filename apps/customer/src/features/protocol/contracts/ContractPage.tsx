import { useMemo, useState, type FormEvent } from 'react';
import type { ContractFunction, ContractSource, ProtocolContractInspect } from '@intafaced/contracts/protocol-contract-source';
import { navigate } from '../../../app/location';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { Button, EmptyState, Failure, Field, Loading, Page, Panel } from '../../../shared/ui';
import { useApi } from '../../session/session';
import { createProtocolApi, type ProtocolApi } from '../api';
import { protocolCopy } from '../copy';
import { ADDRESS_SHAPE } from '../routes';
import { TabList } from '../tokens/TabList';
import { RepresentationPanel } from '../wallet/RepresentationPanel';
import { signingGate, type SigningGate } from '../wallet/signing-gate';
import { walletCopy } from '../wallet/copy';
import { useWallet, waitMined } from '../wallet/WalletProvider';
import { contractCopy, type ContractTranslate } from './copy';
import '../protocol.css';
import '../tokens/tokens.css';

type Tab = 'read' | 'write';

/** The service's refusal text without its code prefix (`protocol.contract_argument_invalid: argument 2, …`). */
const plain = (message: string) => message.replace(/^[a-z_.]+:\s*/, '');

/** The status line: "Exact match: …", "Similar match: …" or "Unverified: …" with its reason. */
export function sourceLine(source: ContractSource, t: ContractTranslate): string {
  return source.status === 'unverified'
    ? t(`status_unverified_${source.reason}`)
    : t(`status_${source.status}`, { name: source.name, sourceName: source.sourceName, compiler: source.compiler });
}
const sourceReason = (source: ContractSource, t: ContractTranslate): string =>
  source.status === 'unverified' ? t(`reason_unverified_${source.reason}`) : t(`reason_${source.status}`);

function SourcePanel({ data, t }: { data: ProtocolContractInspect; t: ContractTranslate }) {
  const { source, proxy } = data;
  return (
    <Panel title={t('sourceTitle')}>
      <p data-testid="contract-source-status" data-status={source.status}>
        {sourceLine(source, t)}
      </p>
      <p className="muted" data-testid="contract-source-reason">
        {sourceReason(source, t)}
      </p>
      {source.status !== 'unverified' && (
        <dl className="protocol-facts">
          <div>
            <dt>{t('sourceHash')}</dt>
            <dd className="numeric">{source.sourceHash}</dd>
          </div>
        </dl>
      )}
      {proxy && (
        <section aria-label={t('proxyTitle')}>
          <h3>{t('proxyTitle')}</h3>
          <p data-testid="contract-implementation" data-address={proxy.implementation.toLowerCase()}>
            <a href={`/protocol/contracts/${proxy.implementation}`}>
              {t('implementation', { address: proxy.implementation, standard: t(`proxy_${proxy.standard}`) })}
            </a>
          </p>
          <p data-testid="contract-implementation-source" data-status={proxy.source.status}>
            {t('implementationSource', { status: sourceLine(proxy.source, t) })}
          </p>
        </section>
      )}
      <p className="muted" data-testid="contract-read-at">
        {t('readAt', { block: data.blockNumber })}
      </p>
    </Panel>
  );
}

/** One input per argument, each labelled with its name and type; lists and tuples are written as JSON. */
function ArgumentFields({
  fn,
  values,
  onChange,
  t,
}: {
  fn: ContractFunction;
  values: string[];
  onChange: (next: string[]) => void;
  t: ContractTranslate;
}) {
  return (
    <>
      {fn.inputs.map((input, i) => (
        <Field
          key={`${input.name}:${i}`}
          label={`${input.name || `#${i + 1}`} (${input.type})`}
          hint={/\[|tuple/.test(input.type) ? t('argJson') : undefined}
          value={values[i] ?? ''}
          onChange={(event) => onChange(values.map((value, j) => (j === i ? event.target.value : value)))}
          autoComplete="off"
          spellCheck={false}
        />
      ))}
    </>
  );
}

function ReadFunction({ address, fn, api, t }: { address: string; fn: ContractFunction; api: ProtocolApi; t: ContractTranslate }) {
  const [values, setValues] = useState<string[]>(() => fn.inputs.map(() => ''));
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ block: string; outputs: Array<{ name: string; type: string; value: string }> } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    setAnswer(null);
    const result = await api.contractRead({ address, signature: fn.signature, args: values });
    setBusy(false);
    if (!result.ok) return setProblem(plain(result.message));
    setAnswer({ block: result.data.blockNumber, outputs: result.data.outputs });
  };
  return (
    <form aria-label={fn.signature} className="contract-function" onSubmit={(event) => void submit(event)}>
      <h4 className="numeric">{fn.signature}</h4>
      <ArgumentFields fn={fn} values={values} onChange={setValues} t={t} />
      <Button type="submit" variant="secondary" disabled={busy}>
        {t('query')}
      </Button>
      {problem && <p role="alert">{problem}</p>}
      {answer && (
        <output data-testid="contract-read-result" data-block={answer.block}>
          <ul>
            {answer.outputs.map((out, i) => (
              <li key={i} data-type={out.type} className="numeric">
                {out.name ? `${out.name} ` : ''}
                {out.type}: <span data-testid="contract-read-value">{out.value}</span>
              </li>
            ))}
          </ul>
          <span className="muted">{t('resultAt', { block: answer.block })}</span>
        </output>
      )}
    </form>
  );
}

function WriteFunction({ address, fn, api, t }: { address: string; fn: ContractFunction; api: ProtocolApi; t: ContractTranslate }) {
  const wallet = useWallet();
  const { language } = usePreferences();
  const { t: tw } = walletCopy.forLocale(language);
  const [values, setValues] = useState<string[]>(() => fn.inputs.map(() => ''));
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [gate, setGate] = useState<{ needed: Extract<SigningGate, { kind: 'needed' }>; resume: () => void } | null>(null);
  const account = wallet.status === 'connected' ? wallet.address : null;

  const send = async () => {
    const built = await api.contractBuildWrite({
      address,
      signature: fn.signature,
      args: values,
      ...(fn.stateMutability === 'payable' && value.trim() ? { value: value.trim() } : {}),
    });
    if (!built.ok) return setProblem(t('writeFailed', { message: plain(built.message) }));
    setBusy(true);
    const result = await wallet.sign({ kind: 'transaction', to: built.data.to, data: built.data.data, value: built.data.value });
    if (result.status !== 'sent') {
      setBusy(false);
      if (result.status === 'rejected') return setProblem(t('writeRejected'));
      return setProblem(t('writeFailed', { message: result.status === 'failed' ? result.message : '' }));
    }
    setOutcome(t('writeSent', { hash: result.hash }));
    const mined = await waitMined((hash) => wallet.read('eth_getTransactionReceipt', [hash]), result.hash, 120_000);
    setBusy(false);
    setOutcome(
      mined.status === 'success'
        ? t('writeMined', { block: String(mined.blockNumber ?? ''), hash: result.hash })
        : mined.status === 'reverted'
          ? t('writeReverted', { hash: result.hash })
          : t('writeNotMined', { hash: result.hash }),
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setOutcome(null);
    if (!account) return;
    const outcomeOfGate = await signingGate(api, account);
    if (outcomeOfGate.kind === 'refused') return setProblem(tw(outcomeOfGate.key));
    if (outcomeOfGate.kind === 'needed') return setGate({ needed: outcomeOfGate, resume: () => void send() });
    await send();
  };

  return (
    <form aria-label={fn.signature} className="contract-function" onSubmit={(event) => void submit(event)}>
      {gate && (
        <RepresentationPanel
          address={gate.needed.address}
          status={gate.needed.status}
          api={api}
          onEnd={(end) => {
            const resume = gate.resume;
            setGate(null);
            if (end.kind === 'accepted') resume();
            else if (end.kind === 'rejected') setProblem(t('writeRejected'));
            else if (end.kind === 'region') setProblem(tw('permitRefused_region'));
            else setProblem(t('writeFailed', { message: end.message }));
          }}
        />
      )}
      <h4 className="numeric">{fn.signature}</h4>
      <ArgumentFields fn={fn} values={values} onChange={setValues} t={t} />
      {fn.stateMutability === 'payable' && (
        <Field label={t('value')} value={value} onChange={(event) => setValue(event.target.value)} inputMode="numeric" autoComplete="off" />
      )}
      <Button type="submit" disabled={busy || !account || wallet.guard?.ok !== true}>
        {t('write')}
      </Button>
      {problem && <p role="alert">{problem}</p>}
      {outcome && (
        <p role="status" data-testid="contract-write-result">
          {outcome}
        </p>
      )}
    </form>
  );
}

function Tabs({ data, api, t }: { data: ProtocolContractInspect; api: ProtocolApi; t: ContractTranslate }) {
  const wallet = useWallet();
  const [tab, setTab] = useState<Tab>('read');
  const face = data.interface;
  const tabs = [
    { id: 'read' as const, label: t('tab_read') },
    { id: 'write' as const, label: t('tab_write') },
  ];
  const refusal = !face ? (
    <p role="status" data-testid="contract-no-interface">
      {t('noInterface', { status: sourceLine(data.proxy?.source ?? data.source, t) })}
    </p>
  ) : null;
  const intro = face ? (
    <p className="muted" data-testid="contract-interface" data-from={face.from}>
      {t(face.from === 'implementation' ? 'interface_implementation' : 'interface_contract', { name: face.name })}
    </p>
  ) : null;
  return (
    <TabList label={t('tabs')} tabs={tabs} value={tab} onChange={setTab}>
      {refusal ??
        (tab === 'read' ? (
          <>
            {intro}
            {face!.read.length === 0 ? (
              <EmptyState title={t('noReads')} />
            ) : (
              face!.read.map((fn) => <ReadFunction key={fn.signature} address={data.address} fn={fn} api={api} t={t} />)
            )}
          </>
        ) : (
          <>
            {intro}
            {wallet.status !== 'connected' ? (
              <p role="status" data-testid="contract-write-connect">
                {t('writeConnect')} <a href="/wallet">{t('writeConnectLink')}</a>
              </p>
            ) : wallet.guard?.ok !== true ? (
              <p role="status">{t('writeWrongChain')}</p>
            ) : (
              <p className="muted">{t('writeNote')}</p>
            )}
            {face!.write.length === 0 ? (
              <EmptyState title={t('noWrites')} />
            ) : (
              face!.write.map((fn) => <WriteFunction key={fn.signature} address={data.address} fn={fn} api={api} t={t} />)
            )}
          </>
        ))}
    </TabList>
  );
}

function ContractBody({ address, t }: { address: string; t: ContractTranslate }) {
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const { resource, reload } = useResource((signal) => api.contractInspect(address, signal), `contract:${address.toLowerCase()}`);
  if (resource.status === 'loading') return <Loading label={t('checking')} />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  return (
    <>
      <SourcePanel data={resource.data} t={t} />
      <Panel title={t('tabs')}>
        <Tabs data={resource.data} api={api} t={t} />
      </Panel>
    </>
  );
}

/** One contract's page (D-explorer-06): its source status, its proxy and implementation, and the Read and Write tabs. */
export function ContractPage({ address }: { address: string | undefined }) {
  const { language } = usePreferences();
  const { t, renderedLocale } = contractCopy.forLocale(language);
  const room = protocolCopy.forLocale(language).t;
  const valid = address !== undefined && ADDRESS_SHAPE.test(address);
  return (
    <div className="legacy-room protocol-room tokens-room" lang={renderedLocale} data-route="contractDetail">
      <Page
        title={valid ? t('pageTitle', { address }) : t('notFoundTitle')}
        eyebrow={<span className="badge protocol-pill">{room('bannerPill')}</span>}
      >
        {valid ? (
          <ContractBody key={address.toLowerCase()} address={address} t={t} />
        ) : (
          <Panel title={t('notFoundTitle')}>
            <div data-code="protocol.not_found" role="status">
              <EmptyState title={t('notFoundBody')} />
            </div>
          </Panel>
        )}
        <Button variant="secondary" onClick={() => navigate('/protocol/contracts')}>
          {t('back')}
        </Button>
      </Page>
    </div>
  );
}

/** The Contracts tab's lookup: any address opens its contract page. */
export function ContractLookup() {
  const { language } = usePreferences();
  const { t } = contractCopy.forLocale(language);
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      aria-label={t('lookupOpen')}
      onSubmit={(event) => {
        event.preventDefault();
        const address = value.trim();
        if (!ADDRESS_SHAPE.test(address)) return setProblem(t('lookupInvalid'));
        navigate(`/protocol/contracts/${address}`);
      }}
    >
      <Field
        label={t('lookupLabel')}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        error={problem ?? undefined}
        autoComplete="off"
        spellCheck={false}
      />
      <Button type="submit">{t('lookupOpen')}</Button>
    </form>
  );
}
