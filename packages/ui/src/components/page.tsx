import type { ReactNode } from 'react';

/** Page frame shared by business screens; matches the Home/Money container and type scale. */
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
    <div data-slot="page" className="mx-auto w-[calc(100%-32px)] max-w-(--if-container-max) py-8 text-fg md:w-[calc(100%-56px)]">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && <p className="mb-2 text-sm font-medium text-fg-2">{eyebrow}</p>}
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-2 max-w-2xl text-base text-fg-2">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}
