import { type HTMLAttributes, type ReactNode } from 'react';
import { TextArea as KitTextArea, type TextAreaProps } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';

/**
 * The agent pages' small parts, drawn with the Volt kit. Each keeps the words, roles and names of the part it stands in
 * for (`shared/ui` Panel and Dialog, `features/more/common` TextArea), so a journey finds what it found before.
 */
export { FailureBox as Failure, ReadView as Read, RecordTable as DataTable } from '../../../shared/record/record-parts';

/** A titled part of an agent's page: its heading, then its parts one under another. A `role`/`aria-label` names it as a region. */
export function Panel({ title, children, ...rest }: { title?: ReactNode; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <section {...rest} className="lt-stack">
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  );
}

/** A modal step over the page, named by its title; Escape or its close button closes it. */
export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <Sheet open title={title} onClose={onClose}>
      <div className="lt-stack">{children}</div>
    </Sheet>
  );
}

/** A few lines of free text, five rows tall, at most 10,000 characters unless the caller says fewer. */
export function TextArea({ maxLength = 10000, rows = 5, ...rest }: TextAreaProps) {
  return <KitTextArea {...rest} maxLength={maxLength} rows={rows} />;
}

/** One answer typed into the page: the kit's field, its words naming the box and its hint under it. */
export { Field } from '@intafaced/ui/lit';
