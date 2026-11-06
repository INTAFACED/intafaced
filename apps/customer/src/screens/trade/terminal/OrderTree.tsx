/**
 * Order tree: one tree of every kind of order (care, synthetic, algo, RFQ, routed), each parent with its children, its
 * owner and its open exposure (tree.ts). A WAI-ARIA tree: each branch and parent is a treeitem with aria-expanded and a
 * Collapse/Expand button; arrow keys move between visible items, Right and Left open and close.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { Badge, fmtAmount, fmtPrice } from '../rooms/ui';
import type { Branch, TreeChild, TreeParent } from './tree';
import { terminalCopy } from './copy';

const BRANCH_WORD = {
  care: 'Branch care',
  synthetic: 'Branch synthetic',
  algo: 'Branch algo',
  rfq: 'Branch rfq',
  routed: 'Branch routed',
} as const;
const EMPTY_WORD = { synthetic: 'Empty synthetic', algo: 'Empty algo', rfq: 'Empty rfq' } as const;
const NOT_RUN_WORD = { care_desk_not_open: 'Not run care_desk_not_open', no_second_book: 'Not run no_second_book' } as const;
const TYPE_WORD: Record<string, string> = {
  twap: 'TWAP',
  vwap: 'VWAP',
  pov: 'POV',
  chase: 'Chase',
  rfq: 'RFQ',
  stop: 'Stop',
  stop_limit: 'Stop limit',
  take_profit: 'Take profit',
  oco: 'OCO',
  bracket_exit: 'Bracket exit',
};

const STATE_WORD = {
  active: 'Algo active',
  paused: 'Algo paused',
  halted: 'Algo halted',
  open: 'Row open',
  partial: 'Row partial',
  recovery: 'State recovery',
  accepted: 'State accepted',
} as const;
const stateKey = (state: string) => (Object.hasOwn(STATE_WORD, state) ? STATE_WORD[state as keyof typeof STATE_WORD] : null);

/** Moves focus between the tree's visible items: Up, Down, Home, End; Right opens, Left closes. */
function onTreeKey(event: KeyboardEvent<HTMLUListElement>, toggle: (id: string, open: boolean) => void) {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role=treeitem]')].filter((el) => el.offsetParent !== null);
  const current = (event.target as HTMLElement).closest<HTMLElement>('[role=treeitem]');
  const at = current ? items.indexOf(current) : -1;
  const go = (i: number) => items[Math.max(0, Math.min(items.length - 1, i))]?.focus();
  if (event.key === 'ArrowDown') go(at + 1);
  else if (event.key === 'ArrowUp') go(at - 1);
  else if (event.key === 'Home') go(0);
  else if (event.key === 'End') go(items.length - 1);
  else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && current?.dataset.node)
    toggle(current.dataset.node, event.key === 'ArrowRight');
  else return;
  event.preventDefault();
}

export function OrderTree({ branches, rfqUnread = false }: { branches: readonly Branch[]; rfqUnread?: boolean }) {
  const { t } = terminalCopy.useCopy();
  // Everything starts open; the person closes what they do not need.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const root = useRef<HTMLUListElement>(null);
  const toggle = (id: string, open: boolean) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  const isOpen = (id: string) => !closed.has(id);

  const Toggle = ({ id, name }: { id: string; name: string }) => (
    <button
      type="button"
      tabIndex={-1}
      className="inline-flex size-6 items-center justify-center rounded-sm text-fg-2 hover:text-fg"
      aria-label={isOpen(id) ? t('Collapse', { name }) : t('Expand', { name })}
      onClick={() => toggle(id, !isOpen(id))}
    >
      <span aria-hidden="true">{isOpen(id) ? '▾' : '▸'}</span>
    </button>
  );

  const exposureText = (p: TreeParent) =>
    p.exposure ? t('Exposure: {amount} {asset}', { amount: fmtAmount(p.exposure.amount), asset: p.exposure.asset }) : t('Exposure unknown');

  const child = (c: TreeChild) => (
    <li key={c.id} role="treeitem" tabIndex={-1} aria-label={`${c.kind === 'slice' ? t('Slice {n}', { n: String(c.index + 1) }) : t('Quote {n}', { n: String(c.index) })} ${c.ref}`} className="flex flex-wrap items-center gap-2 py-1 ps-8 text-sm">
      <span className="text-fg-2">{c.kind === 'slice' ? t('Slice {n}', { n: String(c.index + 1) }) : t('Quote {n}', { n: String(c.index) })}</span>
      <span className="font-mono text-xs">{c.ref}</span>
      {c.qty !== null ? <span>{fmtAmount(c.qty)}</span> : null}
      {c.price !== null ? <span>@ {fmtPrice(c.price, null)}</span> : null}
      <Badge variant="outline">{c.state ?? t('Not on the book')}</Badge>
    </li>
  );

  const parent = (p: TreeParent) => {
    const name = `${TYPE_WORD[p.type] ?? p.type} ${p.ref}`;
    const open = isOpen(p.id);
    return (
      <li
        key={p.id}
        role="treeitem"
        tabIndex={-1}
        data-node={p.id}
        aria-label={name}
        aria-expanded={p.children.length > 0 ? open : undefined}
        className="flex flex-col py-1 ps-4"
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {p.children.length > 0 ? <Toggle id={p.id} name={name} /> : <span className="inline-block size-6" aria-hidden="true" />}
          <Badge variant="outline">{TYPE_WORD[p.type] ?? p.type}</Badge>
          <span className="font-mono text-xs">{p.ref}</span>
          <span>
            {p.symbol} · {p.side === 'buy' ? t('Buy') : t('Sell')}
          </span>
          <Badge>{stateKey(p.state) ? t(stateKey(p.state)!) : p.state}</Badge>
          <span className="text-fg-2">{t('Owner: you')}</span>
          <span className="text-fg-2">{exposureText(p)}</span>
        </div>
        {p.children.length > 0 ? (
          <ul role="group" hidden={!open} className="m-0 list-none p-0">
            {p.children.map(child)}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <ul
      ref={root}
      role="tree"
      aria-label={t('Orders')}
      className="m-0 flex list-none flex-col gap-1 rounded-md border border-line bg-panel p-2"
      onKeyDown={(e) => onTreeKey(e, toggle)}
    >
      {branches.map((b, i) => {
        const id = `branch:${b.kind}`;
        const title = t(BRANCH_WORD[b.kind]);
        const count = b.parents.length > 0 ? t('{n} open', { n: String(b.parents.length) }) : t('None open');
        const open = isOpen(id);
        const reason = b.kind === 'rfq' && rfqUnread ? t('RFQ unread') : b.notRun ? t(NOT_RUN_WORD[b.notRun]) : b.kind in EMPTY_WORD ? t(EMPTY_WORD[b.kind as keyof typeof EMPTY_WORD]) : '';
        return (
          <li key={id} role="treeitem" tabIndex={i === 0 ? 0 : -1} data-node={id} aria-label={`${title}, ${count}`} aria-expanded={open} className="flex flex-col py-1">
            <div className="flex items-center gap-2">
              <Toggle id={id} name={title} />
              <span className="font-semibold text-fg">{title}</span>
              <span className="text-sm text-fg-2">{count}</span>
            </div>
            <ul role="group" hidden={!open} className="m-0 list-none p-0">
              {b.parents.length > 0 ? (
                b.parents.map(parent)
              ) : (
                <li role="none" className="py-1 ps-10 text-sm text-fg-2">
                  {reason}
                </li>
              )}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
