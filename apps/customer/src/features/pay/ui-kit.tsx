import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { Page as KitPage, PageBody, PageHeader, StateBlock } from '@intafaced/ui';

/**
 * Pay screens' thin adapters over the shared `@intafaced/ui` kit.
 *
 * The shared Page/Field/EmptyState (packages/ui) are the kit's own API: a composable page, a Field that wraps an `Input`
 * (value-based, text or decimal only) and an EmptyState with plain-string copy and object actions. The Pay pages need a
 * one-call page frame with an eyebrow, a labelled native input (email, url, password, inputMode, onChange events) and an
 * empty state with a router-link action, so they go through these adapters instead of growing the shared components.
 */

/** Page frame for Pay screens: the shared page lane and header, with an eyebrow line above the title. The app Shell owns `<main>`. */
export function Page({
  eyebrow,
  title,
  description,
  actions,
  children,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <KitPage landmark={false}>
      <PageHeader
        title={title}
        description={description}
        actions={actions}
        breadcrumbs={eyebrow ? <p className="m-0 text-sm font-medium text-fg-2">{eyebrow}</p> : undefined}
      />
      <PageBody>{children}</PageBody>
    </KitPage>
  );
}

/** Labelled native input. Keeps browser validation and links helper/error copy to the input. */
export function Field({
  label,
  hint,
  error,
  className,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}) {
  const generatedId = useId();
  const id = input.id ?? `${input.name ?? 'field'}-${generatedId}`;
  const describedBy = [input['aria-describedby'], hint || error ? `${id}-help` : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <label data-slot="field" className={`flex min-w-0 flex-col gap-1.5 text-sm font-medium text-fg-2 ${className ?? ''}`} htmlFor={id}>
      <span id={`${id}-label`}>{label}</span>
      <input
        {...input}
        id={id}
        aria-labelledby={input['aria-label'] ? undefined : `${id}-label`}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        className="h-10 w-full min-w-0 rounded-sm border border-transparent bg-field px-3 text-base font-normal text-fg placeholder:text-fg-2 outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-40 aria-invalid:border-down-text"
      />
      {(hint || error) && (
        <small id={`${id}-help`} className={error ? 'text-down-text' : 'text-fg-2'}>
          {error ?? hint}
        </small>
      )}
    </label>
  );
}

/** Empty panel with a caller-owned action (including router links). */
export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div data-slot="empty-state">
      <StateBlock kind="empty" title={title} body={children} />
      {action && <div className="mb-8 flex justify-center">{action}</div>}
    </div>
  );
}
