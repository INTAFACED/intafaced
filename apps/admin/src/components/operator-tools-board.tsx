'use client';

import { useMemo, useRef, useState } from 'react';
import { Panel } from '@intafaced/ui';
import { Chip } from '@/components/chip';
import { OperatorQueues, type QueueActionContext } from '@/components/operator-queues';
import {
  fetchOperatorTools,
  invokeOperatorToolBrowser,
  type InvokeResponse,
  type ToolListItem,
  type ToolListResponse,
} from '@/lib/operator-tools-browser';
import { TOOL_GROUPS, usesAccountConsole } from '@/lib/operator-tools-catalog';

/**
 * Operator tools board — lists mounted procedures and invokes via BFF.
 *
 * Rules:
 * 1. not-wired tools never look live; missing env var is named at the control.
 * 2. A failed invoke never advances local "success" state — only the response.
 * 3. Consequential tools require an explicit acknowledge before POST.
 */

export interface OperatorToolsBoardProps {
  initial: ToolListResponse;
}

export function confirmationPhrase(tool: Pick<ToolListItem, 'procedure'>): string {
  return `INVOKE ${tool.procedure}`;
}

export function OperatorToolsBoard({ initial }: OperatorToolsBoardProps) {
  const [catalog, setCatalog] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial.tools[0]?.id ?? null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const [result, setResult] = useState<InvokeResponse | null>(null);
  const [lockedToolId, setLockedToolId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [queueRefreshToken, setQueueRefreshToken] = useState(0);
  const [queueAction, setQueueAction] = useState<QueueActionContext | null>(null);
  const invocationLockRef = useRef(false);

  const selected = useMemo(() => catalog.tools.find((t) => t.id === selectedId) ?? null, [catalog.tools, selectedId]);

  function selectTool(id: string, fields: Record<string, string> = {}, context: QueueActionContext | null = null) {
    if (invocationLockRef.current) return;
    setSelectedId(id);
    setFieldValues(fields);
    setQueueAction(context);
    setAcknowledged(false);
    setTypedConfirmation('');
    setResult(null);
  }

  function refresh() {
    if (refreshing || invocationLockRef.current) return;
    setRefreshing(true);
    void (async () => {
      const next = await fetchOperatorTools();
      setCatalog(next);
      setRefreshing(false);
    })();
  }

  function run() {
    if (!selected) return;
    if (usesAccountConsole(selected.id)) return;
    if (invocationLockRef.current) return;
    if (selected.wire === 'not-wired') return;
    if (selected.consequential && (!acknowledged || typedConfirmation !== confirmationPhrase(selected))) return;

    const input: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fieldValues)) {
      if (v.trim() !== '') input[k] = v;
    }

    invocationLockRef.current = true;
    setLockedToolId(selected.id);
    setResult(null);

    void (async () => {
      const res = await invokeOperatorToolBrowser(selected.id, input);
      setResult(res);
      // Never invent success for a consequential tool that did not deliver.
      if (res.ok && res.delivered) {
        setAcknowledged(false);
        setTypedConfirmation('');
        if (queueAction) setQueueRefreshToken((value) => value + 1);
      }
      invocationLockRef.current = false;
      setLockedToolId(null);
    })();
  }

  const wiredCount = catalog.tools.filter((t) => t.wire === 'wired').length;
  const notWiredCount = catalog.tools.length - wiredCount;

  return (
    <div className="adm-tools-page">
      <OperatorQueues
        catalog={catalog}
        pending={refreshing || lockedToolId != null}
        refreshToken={queueRefreshToken}
        onOpenTool={(id, fields, context) => selectTool(id, fields, context)}
      />
      <OperatorToolsView
        catalog={catalog}
        selected={selected}
        fieldValues={fieldValues}
        acknowledged={acknowledged}
        typedConfirmation={typedConfirmation}
        result={result}
        pending={refreshing || lockedToolId != null}
        lockedToolId={lockedToolId}
        wiredCount={wiredCount}
        notWiredCount={notWiredCount}
        queueAction={queueAction}
        onSelect={(id) => selectTool(id)}
        onField={(name, value) => setFieldValues((prev) => ({ ...prev, [name]: value }))}
        onAcknowledge={setAcknowledged}
        onConfirmation={setTypedConfirmation}
        onRun={run}
        onRefresh={refresh}
      />
    </div>
  );
}

// ── Pure view (testable via renderToStaticMarkup) ────────────────────────────

export interface OperatorToolsViewProps {
  catalog: ToolListResponse;
  selected: ToolListItem | null;
  fieldValues: Record<string, string>;
  acknowledged: boolean;
  typedConfirmation: string;
  result: InvokeResponse | null;
  pending: boolean;
  lockedToolId: string | null;
  wiredCount: number;
  notWiredCount: number;
  queueAction: QueueActionContext | null;
  onSelect: (id: string) => void;
  onField: (name: string, value: string) => void;
  onAcknowledge: (v: boolean) => void;
  onConfirmation: (value: string) => void;
  onRun: () => void;
  onRefresh: () => void;
}

export function OperatorToolsView(props: OperatorToolsViewProps) {
  const { catalog, selected, result } = props;
  const requiredFieldsReady =
    selected?.fields.every((field) => !field.required || (props.fieldValues[field.name] ?? '').trim() !== '') ?? false;
  const confirmationReady =
    selected == null || !selected.consequential || (props.acknowledged && props.typedConfirmation === confirmationPhrase(selected));
  const accountConsole = selected !== null && usesAccountConsole(selected.id);
  const canRun =
    selected != null && !accountConsole && selected.wire === 'wired' && !props.pending && requiredFieldsReady && confirmationReady;

  return (
    <>
      <div className="adm-pagehead">
        <div>
          <h1>Operator tools</h1>
          <p>
            Review the available operator procedures. Requests use your current founder session; each service checks the permissions needed
            for the action. Account restrictions are managed in <a href="/accounts">Account controls</a>.
          </p>
        </div>
        <button type="button" className="adm-btn" onClick={props.onRefresh} disabled={props.pending}>
          Refresh wire status
        </button>
      </div>

      <div className="adm-callout" data-tone={props.notWiredCount === 0 ? 'info' : 'warn'}>
        <strong>
          {props.wiredCount} wired · {props.notWiredCount} not-wired
        </strong>
        {catalog.edgeUrl ? (
          <>
            {' '}
            Current founder session <Chip tone="live">required</Chip>. Connection availability does not grant service permissions.
          </>
        ) : (
          <>
            {' '}
            <code>EDGE_URL</code> is not set on this console — every tool below is inert.
          </>
        )}
        {catalog.error && <> Load error: {catalog.error}</>}
      </div>

      {catalog.residual && (
        <p className="adm-footnote">
          Residual: {catalog.residual.reconcile}. {catalog.residual.sso}.
        </p>
      )}

      <div className="adm-split adm-split--tools">
        <div className="adm-stack">
          {TOOL_GROUPS.map((group) => {
            const tools = catalog.tools.filter((t) => t.group === group.id);
            if (tools.length === 0) return null;
            return (
              <Panel key={group.id} title={group.label}>
                <ul className="adm-tool-list">
                  {tools.map((tool) => {
                    const active = selected?.id === tool.id;
                    return (
                      <li key={tool.id}>
                        <button
                          type="button"
                          className="adm-tool-row"
                          data-active={active ? 'true' : undefined}
                          data-wire={tool.wire}
                          disabled={props.pending}
                          onClick={() => props.onSelect(tool.id)}
                        >
                          <span className="adm-tool-row__label">{tool.label}</span>
                          <span className="adm-tool-row__meta">
                            <Chip tone={tool.wire === 'wired' ? 'live' : 'warn'}>{tool.wire}</Chip>
                            {tool.consequential && <Chip tone="danger">consequential</Chip>}
                            <code>{tool.procedure}</code>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Panel>
            );
          })}
        </div>

        <div className="adm-stack">
          {selected ? (
            <Panel
              title={selected.label}
              actions={
                <>
                  <Chip tone={selected.wire === 'wired' ? 'live' : 'warn'}>{selected.wire}</Chip>
                  <Chip tone="info">{selected.scope}</Chip>
                </>
              }
            >
              <div className="adm-stack">
                <p className="adm-footnote">{selected.summary}</p>
                <p className="adm-footnote">
                  Edge path:{' '}
                  <code>
                    /api/{selected.edgeModule}/trpc/{selected.procedure}
                  </code>{' '}
                  · {selected.kind} · authority {selected.authority}
                </p>

                {selected.wire === 'not-wired' && (
                  <div className="adm-callout" data-tone="warn" data-testid="tool-not-wired">
                    <strong>Not wired</strong>
                    {selected.detail ?? 'Missing configuration.'} Set{' '}
                    {selected.missing.map((name, i) => (
                      <span key={name}>
                        {i > 0 && ' + '}
                        <code>{name}</code>
                      </span>
                    ))}
                    . This button will not claim success without a network call.
                  </div>
                )}

                {accountConsole && (
                  <p>
                    Inspect current state and record a reason in <a href="/accounts">Account controls</a>.
                  </p>
                )}
                {(accountConsole ? [] : selected.fields).map((field) => (
                  <div key={field.name} className="adm-field">
                    <label htmlFor={`tool-field-${field.name}`}>
                      {field.label}
                      {field.required ? ' *' : ''}
                    </label>
                    {field.type === 'enum' && field.enumValues ? (
                      <select
                        id={`tool-field-${field.name}`}
                        className="adm-input"
                        value={props.fieldValues[field.name] ?? ''}
                        disabled={selected.wire === 'not-wired' || props.pending}
                        onChange={(e) => props.onField(field.name, e.target.value)}
                      >
                        <option value="">—</option>
                        {field.enumValues.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    ) : field.type === 'json' ? (
                      <textarea
                        id={`tool-field-${field.name}`}
                        className="adm-textarea"
                        rows={4}
                        value={props.fieldValues[field.name] ?? ''}
                        placeholder={field.placeholder}
                        disabled={selected.wire === 'not-wired' || props.pending}
                        onChange={(e) => props.onField(field.name, e.target.value)}
                      />
                    ) : (
                      <input
                        id={`tool-field-${field.name}`}
                        className="adm-input"
                        value={props.fieldValues[field.name] ?? ''}
                        placeholder={field.placeholder}
                        disabled={selected.wire === 'not-wired' || props.pending}
                        onChange={(e) => props.onField(field.name, e.target.value)}
                      />
                    )}
                    {field.hint && <span className="adm-footnote">{field.hint}</span>}
                  </div>
                ))}

                {selected.consequential && selected.wire === 'wired' && (
                  <div className="adm-confirm" data-testid="tool-confirmation">
                    {props.queueAction && (
                      <div className="adm-callout" data-tone="warn" data-testid="queue-action-context">
                        <strong>Row-scoped review</strong>
                        Record <code>{props.queueAction.recordId}</code> · displayed state <code>{props.queueAction.status}</code> · source
                        version <time dateTime={props.queueAction.version}>{props.queueAction.version}</time>. The service rechecks pending
                        state; its mutation contract has no optimistic version parameter.
                      </div>
                    )}
                    <label className="adm-check">
                      <input
                        type="checkbox"
                        checked={props.acknowledged}
                        disabled={props.pending}
                        onChange={(e) => props.onAcknowledge(e.target.checked)}
                      />
                      <span>I understand this calls the live platform ({selected.scope}) and is not a browser-local preview.</span>
                    </label>
                    <div className="adm-field">
                      <label htmlFor="tool-confirmation-phrase">
                        Type <code>{confirmationPhrase(selected)}</code> to confirm
                      </label>
                      <input
                        id="tool-confirmation-phrase"
                        className="adm-input"
                        autoComplete="off"
                        spellCheck={false}
                        value={props.typedConfirmation}
                        disabled={props.pending}
                        onChange={(event) => props.onConfirmation(event.target.value)}
                      />
                    </div>
                  </div>
                )}

                <div className="adm-actions" aria-busy={props.pending}>
                  <button type="button" className="adm-btn adm-btn--primary" disabled={!canRun} onClick={props.onRun}>
                    {props.lockedToolId === selected.id
                      ? 'Locked — awaiting edge…'
                      : props.pending
                        ? 'Console busy…'
                        : selected.kind === 'query'
                          ? 'Run query'
                          : 'Invoke'}
                  </button>
                  {selected.wire === 'not-wired' && (
                    <span className="adm-blocked">Disabled — {selected.missing.join(' and ')} not set on this console.</span>
                  )}
                </div>
              </div>
            </Panel>
          ) : (
            <Panel title="Select a tool">
              <p className="adm-footnote">Choose a procedure from the list.</p>
            </Panel>
          )}

          {result &&
            (() => {
              const answered = result.ok && result.delivered;
              const resultTool = catalog.tools.find((tool) => tool.id === result.toolId);
              const isQuery = resultTool?.kind === 'query';
              const receiptTitle = isQuery
                ? answered
                  ? 'Query receipt'
                  : 'Query receipt — refused / failed'
                : answered
                  ? 'Delivery receipt'
                  : 'Attempt receipt — refused / failed';
              return (
                <Panel
                  title={receiptTitle}
                  actions={
                    <>
                      <Chip tone={answered ? 'live' : 'danger'}>
                        {isQuery ? (answered ? 'answered' : 'not answered') : answered ? 'applied' : 'not applied'}
                      </Chip>
                      <Chip tone={result.delivered ? 'info' : 'warn'}>{result.delivered ? 'delivered' : 'not delivered'}</Chip>
                      <Chip tone="neutral">HTTP {result.status}</Chip>
                    </>
                  }
                >
                  <div className="adm-stack" data-testid="delivery-receipt">
                    {!answered && result.detail && (
                      <div className="adm-callout" data-tone="danger">
                        <strong>{isQuery ? 'Query was not answered' : 'Not applied as success'}</strong>
                        {result.detail}
                      </div>
                    )}
                    <dl className="adm-kv">
                      <dt>Tool</dt>
                      <dd>{result.toolId}</dd>
                      <dt>Procedure</dt>
                      <dd>{result.procedure || 'not returned'}</dd>
                      <dt>Edge path</dt>
                      <dd>{result.edgePath ?? 'not delivered to edge'}</dd>
                      <dt>Transport</dt>
                      <dd>
                        HTTP {result.status} · {result.delivered ? 'delivered' : 'not delivered'}
                      </dd>
                    </dl>
                    <pre className="adm-pre">{JSON.stringify(result.data, null, 2)}</pre>
                  </div>
                </Panel>
              );
            })()}
        </div>
      </div>
    </>
  );
}
