import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApiResult } from '../../shared/api';
import { ChevronDown, ChevronRight, Circle, CircleDot } from 'lucide-react';
import { Button, Tag } from '@intafaced/ui/lit';
import { DeskTemplate } from '@intafaced/ui/lit/templates';
import { preservePaperHref } from '../more';
import { useApi, useSession } from '../session';
import { QuantRooms } from './QuantRooms';
import { previewCopy } from './preview-copy';
import type { z } from 'zod';
import type { previewActInputSchema } from '@intafaced/contracts/quant-call-schemas';
import { QUANT_PREVIEW_ACT } from '@intafaced/contracts/quant-preview-procedures';

/**
 * The Algo dev Preview rooms (AL-order-01): the code editor, the strategy tester and the optimiser, each at its final
 * route with a full layout on TEST sample data. Local interactions work and keep nothing on a server; every engine action
 * is sent to svc-quant `preview.act`, which refuses it with the platform's typed Preview refusal, said here in words.
 */
type PreviewRoomId = 'editor' | 'tester' | 'optimise';
type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const PREVIEW_CODE = 'preview.engine_not_built';
const ENGINES: Record<string, 'engine_strategy_compiler' | 'engine_strategy_runtime' | 'engine_tick_engine' | 'engine_optimiser'> = {
  'quant.strategy_compiler': 'engine_strategy_compiler',
  'quant.strategy_runtime': 'engine_strategy_runtime',
  'quant.tick_engine': 'engine_tick_engine',
  'quant.optimiser': 'engine_optimiser',
};
const ACTION_LABEL = { compile: 'compile', debug: 'debug', start: 'start', stop: 'stop', resume: 'resume', export: 'export' } as const;

/** One labelled engine action, as the record takes it: each room with only its own actions. */
type EngineAct = z.input<typeof previewActInputSchema> & { action: keyof typeof ACTION_LABEL };

/** Sends one engine action; the service always refuses it. Returns what the alert says. */
function useEngineAction() {
  const api = useApi();
  // The rooms are public, so they render while the boot refresh restores the sign-in. An action sent then would carry no
  // token and be refused as signed out, so every engine button waits for the restore.
  const { restoring } = useSession();
  const [refusal, setRefusal] = useState<{ action: keyof typeof ACTION_LABEL; engine: string | null; failed: Failed } | null>(null);
  async function act(input: EngineAct) {
    if (restoring) return;
    const res = await api.call(QUANT_PREVIEW_ACT, input);
    if (res.ok) return;
    // The refusal's message is `preview.engine_not_built — <engine>:<action>`; the engine names what is missing.
    const engine = /preview\.engine_not_built — ([a-z_.]+):/.exec(res.message ?? '')?.[1] ?? null;
    setRefusal({ action: input.action, engine, failed: res });
  }
  return { refusal, act, waiting: restoring };
}

function PreviewRefusalAlert({ refusal }: { refusal: ReturnType<typeof useEngineAction>['refusal'] }) {
  const { t } = previewCopy.useCopy();
  if (!refusal) return null;
  const key = refusal.engine ? ENGINES[refusal.engine] : undefined;
  const isPreview = Boolean(key) || refusal.failed.code === PREVIEW_CODE;
  return (
    <div
      data-testid="preview-refusal"
      role="alert"
      className="lt-refusal"
      data-code={isPreview ? PREVIEW_CODE : ''}
      data-kind={isPreview ? 'preview' : ''}
    >
      {key ? t('refusal', { action: t(ACTION_LABEL[refusal.action]), engine: t(key) }) : t('refusalOther')} <span>{t('refusalBody')}</span>
    </div>
  );
}

const TITLE = { editor: 'editorTitle', tester: 'testerTitle', optimise: 'optimiseTitle' } as const;

/**
 * The shell every Preview room shares, on the desk template: the room switch, the label, the sample note and the engine
 * refusal head it; `chart` is the room's main panel and `ticket` the panel beside it.
 */
function PreviewShell({
  room,
  paper,
  refusal,
  chart,
  ticket,
}: {
  room: PreviewRoomId;
  paper: boolean;
  refusal: ReturnType<typeof useEngineAction>['refusal'];
  chart: ReactNode;
  ticket: ReactNode;
}) {
  const { t } = previewCopy.useCopy();
  return (
    <div data-testid="quant-preview" data-room={room}>
      <DeskTemplate
        title={t(TITLE[room])}
        description={t('label')}
        mode="pro"
        state={{ kind: 'ready' }}
        instrument={
          <div className="lt-col-main">
            <QuantRooms active={room} paper={paper} />
            <p role="note">
              <Tag tone="accent">
                <strong>{t('label')}</strong>
              </Tag>
            </p>
            <p className="lt-hint">{t('sampleNote')}</p>
            <PreviewRefusalAlert refusal={refusal} />
          </div>
        }
        chart={chart}
        ticket={ticket}
      />
    </div>
  );
}

/** A panel that would show an engine's output: blurred sample data, with a text alternative that says so. */
function EnginePanel({ name, children }: { name: string; children: ReactNode }) {
  const { t } = previewCopy.useCopy();
  return (
    <div data-testid="preview-engine" data-blurred="true" aria-label={t('blurred', { name })} className="lt-blurred">
      {children}
    </div>
  );
}

/** One named part of a room: a labelled section with its heading. */
function Part({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section aria-label={name} className="lt-col-main">
      <h3>{name}</h3>
      {children}
    </section>
  );
}

const SAMPLE_SOURCE = [
  '// TEST sample strategy: two moving averages',
  'export function onBar(bar) {',
  '  const fast = sma(bar.closes, 10);',
  '  const slow = sma(bar.closes, 30);',
  '  if (fast > slow) {',
  '    oms.buy("BTC/USDT", 0.01);',
  '  }',
  '  if (fast < slow) {',
  '    oms.sell("BTC/USDT", 0.01);',
  '  }',
  '}',
];
/** Lines that open a block, and the line that closes each. */
const BLOCKS: Record<number, number> = { 2: 11, 5: 7, 8: 10 };
const EDITOR_KEY = 'quant.preview.editor';

interface EditorState {
  readonly breakpoints: number[];
  readonly folded: number[];
}

function readEditor(): EditorState {
  try {
    const raw = localStorage.getItem(EDITOR_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<EditorState>) : {};
    return {
      breakpoints: Array.isArray(parsed.breakpoints) ? parsed.breakpoints.filter((n) => Number.isInteger(n)) : [],
      folded: Array.isArray(parsed.folded) ? parsed.folded.filter((n) => Number.isInteger(n)) : [],
    };
  } catch {
    return { breakpoints: [], folded: [] };
  }
}

export function EditorRoom({ paper }: { paper: boolean }) {
  const { t } = previewCopy.useCopy();
  const engine = useEngineAction();
  const act = (action: Extract<EngineAct, { room: 'editor' }>['action']) => engine.act({ room: 'editor', action });
  const [state, setState] = useState<EditorState>(readEditor);
  function save(next: EditorState) {
    setState(next);
    // Kept in this browser only, under one key; nothing is sent to a server.
    try {
      localStorage.setItem(EDITOR_KEY, JSON.stringify(next));
    } catch {
      // Storage is unavailable here: the state holds until the page closes.
    }
  }
  const toggle = (list: number[], n: number) => (list.includes(n) ? list.filter((x) => x !== n) : [...list, n].sort((a, b) => a - b));
  const hidden = new Set<number>();
  for (const open of state.folded) for (let line = open + 1; line <= (BLOCKS[open] ?? open); line += 1) hidden.add(line);
  return (
    <PreviewShell
      room="editor"
      paper={paper}
      refusal={engine.refusal}
      chart={
        <div className="lt-col-main">
          <Part name={t('files')}>
            <ul role="tree" aria-label={t('files')}>
              <li role="treeitem" aria-selected="true">
                TEST strategies/two-averages.js
              </li>
              <li role="treeitem" aria-selected="false">
                TEST strategies/breakout.js
              </li>
              <li role="treeitem" aria-selected="false">
                TEST lib/indicators.js
              </li>
            </ul>
          </Part>
          <Part name={t('editor')}>
            <ol className="lt-mono" lang="zxx">
              {SAMPLE_SOURCE.map((text, index) => {
                const line = index + 1;
                if (hidden.has(line)) return null;
                const opens = BLOCKS[line] !== undefined;
                return (
                  <li key={line} data-line={line}>
                    <Button
                      tone="quiet"
                      aria-label={t('breakpoint', { line })}
                      aria-pressed={state.breakpoints.includes(line)}
                      onClick={() => save({ ...state, breakpoints: toggle(state.breakpoints, line) })}
                    >
                      {/* Drawn, not typed: the kit's faces have no ● or ○, so a glyph would fall back to a system font. */}
                      {state.breakpoints.includes(line) ? (
                        <CircleDot size={16} aria-hidden="true" />
                      ) : (
                        <Circle size={16} aria-hidden="true" />
                      )}
                    </Button>
                    {opens && (
                      <Button
                        tone="quiet"
                        aria-label={t('fold', { line })}
                        aria-expanded={!state.folded.includes(line)}
                        onClick={() => save({ ...state, folded: toggle(state.folded, line) })}
                      >
                        {state.folded.includes(line) ? (
                          <ChevronRight size={16} aria-hidden="true" />
                        ) : (
                          <ChevronDown size={16} aria-hidden="true" />
                        )}
                      </Button>
                    )}
                    <code>{text}</code>
                  </li>
                );
              })}
            </ol>
          </Part>
        </div>
      }
      ticket={
        <div className="lt-col-main">
          <Part name={t('compile')}>
            <Button tone="primary" disabled={engine.waiting} onClick={() => void act('compile')}>
              {t('compile')}
            </Button>
            <EnginePanel name={t('compile')}>
              <p className="lt-hint">{t('compileSample')}</p>
              <ul>
                <li>TEST 0 errors, 0 warnings (sample)</li>
                <li>TEST built in 0.4 s (sample)</li>
              </ul>
            </EnginePanel>
            <a className="lt-link" href={preservePaperHref('/quant', paper)}>
              {t('sandbox')}
            </a>
          </Part>
          <Part name={t('debugger')}>
            <Button disabled={engine.waiting} onClick={() => void act('debug')}>
              {t('debug')}
            </Button>
            <EnginePanel name={t('debugger')}>
              <p className="lt-hint">{t('debuggerSample')}</p>
              <ul lang="zxx">
                <li>TEST fast = 101.2</li>
                <li>TEST slow = 99.8</li>
              </ul>
            </EnginePanel>
          </Part>
          <Part name={t('profiler')}>
            <EnginePanel name={t('profiler')}>
              <p className="lt-hint">{t('profilerSample')}</p>
              <ul lang="zxx">
                <li>TEST onBar 0.12 ms</li>
                <li>TEST sma 0.04 ms</li>
              </ul>
            </EnginePanel>
          </Part>
        </div>
      }
    />
  );
}

const TICKS = 240;

export function TesterRoom({ paper }: { paper: boolean }) {
  const { t } = previewCopy.useCopy();
  const engine = useEngineAction();
  const act = (action: Extract<EngineAct, { room: 'tester' }>['action']) => engine.act({ room: 'tester', action });
  // Kept in memory only: a reload starts the sample replay again from the start at 1x.
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!playing) return undefined;
    const id = setInterval(() => setFrame((n) => n + speed), 100);
    return () => clearInterval(id);
  }, [playing, speed]);
  const tick = (frame % TICKS) + 1;
  return (
    <PreviewShell
      room="tester"
      paper={paper}
      refusal={engine.refusal}
      ticket={null}
      chart={
        <Part name={t('replay')}>
          <div data-testid="tester-replay" data-frame={frame} data-speed={speed}>
            <EnginePanel name={t('replay')}>
              <p lang="zxx">TEST BTC/USDT {t('tick', { tick, ticks: TICKS })}</p>
              <progress max={TICKS} value={tick} aria-label={t('tick', { tick, ticks: TICKS })} />
            </EnginePanel>
          </div>
          <label className="lt-field">
            <span>{t('speed')}</span>
            <input
              type="range"
              min={1}
              max={16}
              step={1}
              value={speed}
              aria-label={t('speed')}
              aria-valuetext={`${speed}x`}
              onChange={(event) => setSpeed(Number(event.currentTarget.value))}
            />
          </label>
          <div className="lt-actions">
            <Button onClick={() => setPlaying((p) => !p)}>{playing ? t('pause') : t('play')}</Button>
            <Button tone="primary" disabled={engine.waiting} onClick={() => void act('start')}>
              {t('start')}
            </Button>
          </div>
          <a className="lt-link" href={preservePaperHref('/quant/backtest', paper)}>
            {t('backtest')}
          </a>
        </Part>
      }
    />
  );
}

const PASSES = [
  { pass: 3, profit: '412.50', factor: '1.62', drawdown: '8.1%', trades: 41 },
  { pass: 7, profit: '-120.25', factor: '0.84', drawdown: '12.4%', trades: 38 },
  { pass: 1, profit: '95.00', factor: '1.11', drawdown: '6.0%', trades: 22 },
  { pass: 9, profit: '-310.75', factor: '0.61', drawdown: '19.8%', trades: 57 },
  { pass: 4, profit: '220.10', factor: '1.34', drawdown: '7.3%', trades: 30 },
  { pass: 6, profit: '-15.40', factor: '0.97', drawdown: '9.9%', trades: 26 },
  { pass: 2, profit: '58.80', factor: '1.07', drawdown: '5.2%', trades: 19 },
  { pass: 8, profit: '-88.00', factor: '0.89', drawdown: '11.0%', trades: 33 },
  { pass: 5, profit: '301.30', factor: '1.48', drawdown: '6.6%', trades: 44 },
];

/** Sample walk-forward windows over 600 TEST bars, re-laid for the chosen forward share. */
function windowsOf(forwardPercent: number) {
  const total = 600;
  const count = 4;
  const size = total / count;
  const out = Math.round((size * forwardPercent) / 100);
  return Array.from({ length: count }, (_, i) => ({ n: i + 1, inSample: size - out, outSample: out }));
}

export function OptimiseRoom({ paper }: { paper: boolean }) {
  const { t } = previewCopy.useCopy();
  const engine = useEngineAction();
  const act = (action: Extract<EngineAct, { room: 'optimise' }>['action']) => engine.act({ room: 'optimise', action });
  const [show, setShow] = useState<'all' | 'loss'>('all');
  const [sort, setSort] = useState<'ascending' | 'descending' | null>(null);
  const [walkOpen, setWalkOpen] = useState(false);
  const [preset, setPreset] = useState('25');
  const rows = useMemo(() => {
    const shown = show === 'loss' ? PASSES.filter((row) => row.profit.startsWith('-')) : [...PASSES];
    if (sort) shown.sort((a, b) => (sort === 'ascending' ? a.pass - b.pass : b.pass - a.pass));
    return shown;
  }, [show, sort]);
  const windows = windowsOf(Number(preset));
  // A performance header is a button that keeps the order: passes are never ranked by how well they did.
  const performance = (label: string) => (
    <th scope="col">
      <Button tone="quiet" onClick={() => undefined}>
        {label}
      </Button>
    </th>
  );
  return (
    <PreviewShell
      room="optimise"
      paper={paper}
      refusal={engine.refusal}
      chart={
        <Part name={t('passes')}>
          <Button tone="primary" disabled={engine.waiting} onClick={() => void act('start')}>
            {t('start')}
          </Button>
          <label className="lt-field">
            <span>{t('show')}</span>
            <select
              aria-label={t('show')}
              value={show}
              onChange={(event) => setShow(event.currentTarget.value === 'loss' ? 'loss' : 'all')}
            >
              <option value="all">{t('allPasses')}</option>
              <option value="loss">{t('lossPasses')}</option>
            </select>
          </label>
          <p role="note">{t('sortNote')}</p>
          <EnginePanel name={t('passes')}>
            <table aria-label={t('passes')} className="lt-table">
              <thead>
                <tr>
                  <th scope="col" aria-sort={sort ?? 'none'}>
                    <Button tone="quiet" onClick={() => setSort((s) => (s === 'ascending' ? 'descending' : 'ascending'))}>
                      {t('pass')}
                    </Button>
                  </th>
                  {performance(t('profit'))}
                  {performance(t('profitFactor'))}
                  {performance(t('drawdown'))}
                  {performance(t('trades'))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.pass} data-pass={row.pass}>
                    <td lang="zxx">TEST {row.pass}</td>
                    <td lang="zxx">{row.profit}</td>
                    <td lang="zxx">{row.factor}</td>
                    <td lang="zxx">{row.drawdown}</td>
                    <td lang="zxx">{row.trades}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </EnginePanel>
          <Button onClick={() => setWalkOpen((open) => !open)}>{t('walkForward')}</Button>
        </Part>
      }
      ticket={
        walkOpen ? (
          <Part name={t('walkForward')}>
            <label className="lt-field">
              <span>{t('preset')}</span>
              <select aria-label={t('preset')} value={preset} onChange={(event) => setPreset(event.currentTarget.value)}>
                <option value="25">25%</option>
                <option value="50">50%</option>
              </select>
            </label>
            <EnginePanel name={t('walkForward')}>
              <ol>
                {windows.map((w) => (
                  <li key={w.n} data-testid="wf-window" data-in={w.inSample} data-out={w.outSample}>
                    TEST {t('windowRow', { n: w.n, inSample: w.inSample, outSample: w.outSample })}
                  </li>
                ))}
              </ol>
            </EnginePanel>
            <p data-testid="wf-gate-line">{t('gateLine')}</p>
            <div className="lt-actions">
              <Button disabled={engine.waiting} onClick={() => void act('stop')}>
                {t('stop')}
              </Button>
              <Button disabled={engine.waiting} onClick={() => void act('resume')}>
                {t('resume')}
              </Button>
              <Button disabled={engine.waiting} onClick={() => void act('export')}>
                {t('export')}
              </Button>
            </div>
          </Part>
        ) : null
      }
    />
  );
}
