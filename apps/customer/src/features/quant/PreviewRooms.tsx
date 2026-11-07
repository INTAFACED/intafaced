import { z } from 'zod';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApiResult } from '../../shared/api';
import { Button } from '../../shared/ui';
import { preservePaperHref } from '../more/trade-context';
import { useApi } from '../session/session';
import { QuantRooms } from './QuantRooms';
import { previewCopy } from './preview-copy';
import './algo.css';

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

/** Sends one engine action; the service always refuses it. Returns what the alert says. */
function useEngineAction(room: PreviewRoomId) {
  const api = useApi();
  const [refusal, setRefusal] = useState<{ action: keyof typeof ACTION_LABEL; engine: string | null; failed: Failed } | null>(null);
  async function act(action: keyof typeof ACTION_LABEL) {
    const res = await api.mutate('quant', 'preview.act', { room, action }, z.never());
    if (res.ok) return;
    // The refusal's message is `preview.engine_not_built — <engine>:<action>`; the engine names what is missing.
    const engine = /preview\.engine_not_built — ([a-z_.]+):/.exec(res.message ?? '')?.[1] ?? null;
    setRefusal({ action, engine, failed: res });
  }
  return { refusal, act };
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
      className="failure"
      data-code={isPreview ? PREVIEW_CODE : ''}
      data-kind={isPreview ? 'preview' : ''}
    >
      {key ? t('refusal', { action: t(ACTION_LABEL[refusal.action]), engine: t(key) }) : t('refusalOther')} <span>{t('refusalBody')}</span>
    </div>
  );
}

/** The shell every Preview room shares: the label, the sample note, and the room switch. */
function PreviewShell({ room, paper, children }: { room: PreviewRoomId; paper: boolean; children: ReactNode }) {
  const { t } = previewCopy.useCopy();
  return (
    <>
      <QuantRooms active={room} paper={paper} />
      <div data-testid="quant-preview" data-room={room} className="quant-preview">
        <p className="badge" role="note">
          <strong>{t('label')}</strong>
        </p>
        <p className="muted">{t('sampleNote')}</p>
        {children}
      </div>
    </>
  );
}

/** A panel that would show an engine's output: blurred sample data, with a text alternative that says so. */
function EnginePanel({ name, children }: { name: string; children: ReactNode }) {
  const { t } = previewCopy.useCopy();
  return (
    <div
      data-testid="preview-engine"
      data-blurred="true"
      aria-label={t('blurred', { name })}
      className="preview-engine"
      style={{ filter: 'blur(0.125rem)' }}
    >
      {children}
    </div>
  );
}

function Region({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section aria-label={name} className="panel">
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
  const engine = useEngineAction('editor');
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
    <PreviewShell room="editor" paper={paper}>
      <div className="more-columns">
        <Region name={t('files')}>
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
        </Region>
        <Region name={t('editor')}>
          <ol className="preview-code" lang="zxx">
            {SAMPLE_SOURCE.map((text, index) => {
              const line = index + 1;
              if (hidden.has(line)) return null;
              const opens = BLOCKS[line] !== undefined;
              return (
                <li key={line} data-line={line}>
                  <button
                    type="button"
                    className="preview-gutter"
                    aria-label={t('breakpoint', { line })}
                    aria-pressed={state.breakpoints.includes(line)}
                    onClick={() => save({ ...state, breakpoints: toggle(state.breakpoints, line) })}
                  >
                    {state.breakpoints.includes(line) ? '●' : '○'}
                  </button>
                  {opens && (
                    <button
                      type="button"
                      className="preview-fold"
                      aria-label={t('fold', { line })}
                      aria-expanded={!state.folded.includes(line)}
                      onClick={() => save({ ...state, folded: toggle(state.folded, line) })}
                    >
                      {state.folded.includes(line) ? '▸' : '▾'}
                    </button>
                  )}
                  <code>{text}</code>
                </li>
              );
            })}
          </ol>
        </Region>
      </div>
      <div className="more-columns">
        <Region name={t('compile')}>
          <Button onClick={() => void engine.act('compile')}>{t('compile')}</Button>
          <EnginePanel name={t('compile')}>
            <p className="muted">{t('compileSample')}</p>
            <ul>
              <li>TEST 0 errors, 0 warnings (sample)</li>
              <li>TEST built in 0.4 s (sample)</li>
            </ul>
          </EnginePanel>
          <a className="text-link" href={preservePaperHref('/quant', paper)}>
            {t('sandbox')}
          </a>
        </Region>
        <Region name={t('debugger')}>
          <Button variant="secondary" onClick={() => void engine.act('debug')}>
            {t('debug')}
          </Button>
          <EnginePanel name={t('debugger')}>
            <p className="muted">{t('debuggerSample')}</p>
            <ul lang="zxx">
              <li>TEST fast = 101.2</li>
              <li>TEST slow = 99.8</li>
            </ul>
          </EnginePanel>
        </Region>
        <Region name={t('profiler')}>
          <EnginePanel name={t('profiler')}>
            <p className="muted">{t('profilerSample')}</p>
            <ul lang="zxx">
              <li>TEST onBar 0.12 ms</li>
              <li>TEST sma 0.04 ms</li>
            </ul>
          </EnginePanel>
        </Region>
      </div>
      <PreviewRefusalAlert refusal={engine.refusal} />
    </PreviewShell>
  );
}

const TICKS = 240;

export function TesterRoom({ paper }: { paper: boolean }) {
  const { t } = previewCopy.useCopy();
  const engine = useEngineAction('tester');
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
    <PreviewShell room="tester" paper={paper}>
      <Region name={t('replay')}>
        <div data-testid="tester-replay" data-frame={frame} data-speed={speed} className="preview-replay">
          <EnginePanel name={t('replay')}>
            <p lang="zxx">TEST BTC/USDT {t('tick', { tick, ticks: TICKS })}</p>
            <progress max={TICKS} value={tick} aria-label={t('tick', { tick, ticks: TICKS })} />
          </EnginePanel>
        </div>
        <label className="field">
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
        <Button variant="secondary" onClick={() => setPlaying((p) => !p)}>
          {playing ? t('pause') : t('play')}
        </Button>
        <Button onClick={() => void engine.act('start')}>{t('start')}</Button>
        <a className="text-link" href={preservePaperHref('/quant/backtest', paper)}>
          {t('backtest')}
        </a>
      </Region>
      <PreviewRefusalAlert refusal={engine.refusal} />
    </PreviewShell>
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
  const engine = useEngineAction('optimise');
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
      <button type="button" className="text-link" onClick={() => undefined}>
        {label}
      </button>
    </th>
  );
  return (
    <PreviewShell room="optimise" paper={paper}>
      <Region name={t('passes')}>
        <Button onClick={() => void engine.act('start')}>{t('start')}</Button>
        <label className="field">
          <span>{t('show')}</span>
          <select aria-label={t('show')} value={show} onChange={(event) => setShow(event.currentTarget.value === 'loss' ? 'loss' : 'all')}>
            <option value="all">{t('allPasses')}</option>
            <option value="loss">{t('lossPasses')}</option>
          </select>
        </label>
        <p role="note">{t('sortNote')}</p>
        <EnginePanel name={t('passes')}>
          <table aria-label={t('passes')}>
            <thead>
              <tr>
                <th scope="col" aria-sort={sort ?? 'none'}>
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => setSort((s) => (s === 'ascending' ? 'descending' : 'ascending'))}
                  >
                    {t('pass')}
                  </button>
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
        <Button variant="secondary" onClick={() => setWalkOpen((open) => !open)}>
          {t('walkForward')}
        </Button>
      </Region>
      {walkOpen && (
        <Region name={t('walkForward')}>
          <label className="field">
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
          <Button variant="secondary" onClick={() => void engine.act('stop')}>
            {t('stop')}
          </Button>
          <Button variant="secondary" onClick={() => void engine.act('resume')}>
            {t('resume')}
          </Button>
          <Button variant="secondary" onClick={() => void engine.act('export')}>
            {t('export')}
          </Button>
        </Region>
      )}
      <PreviewRefusalAlert refusal={engine.refusal} />
    </PreviewShell>
  );
}
