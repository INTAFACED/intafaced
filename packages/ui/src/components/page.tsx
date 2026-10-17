'use client';

/**
 * Page chrome for every customer screen: the page frame (`Page`), the title bar (`PageHeader`),
 * the trail above it (`Breadcrumbs`), titled blocks (`PageSection`) and the body column (`PageBody`).
 *
 * Heading rule: one h1 per page (PageHeader), h2 for each PageSection. `headingLevel` can move
 * either down when a page is embedded in a larger one. All text arrives as props; nothing here
 * is hard-coded English except the overridable `Breadcrumb` landmark name.
 */
import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn, focusRing } from './cn.js';
import { DEFAULT_DENSITY, type Density } from './density.js';
import { Skeleton } from './skeleton.js';

export type PageWidth = 'narrow' | 'content' | 'full';

/** narrow = 672 px reading lane, content = --if-container-max (1224 px) centred, full = full bleed. All keep the 24 px gutter. */
const widthClass: Record<PageWidth, string> = {
  narrow: 'mx-auto max-w-[calc(672px+2*var(--if-gutter))]',
  content: 'mx-auto max-w-(--if-container-max)',
  full: 'max-w-none',
};

const PageDensityContext = React.createContext<Density>(DEFAULT_DENSITY);

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface PageProps extends React.ComponentProps<'div'> {
  width?: PageWidth;
  /** Renders a `<main>` landmark (default). Turn off when the app shell already has one. */
  landmark?: boolean;
  /** Spacing of the whole page; PageHeader, PageBody and PageSection read it unless they get their own. */
  density?: Density;
}

/** Page root: width lane, 24 px gutter, and the density the parts inside inherit. */
export function Page({ width = 'content', landmark = true, density = DEFAULT_DENSITY, className, children, ...props }: PageProps) {
  const Root = landmark ? 'main' : 'div';
  return (
    <PageDensityContext.Provider value={density}>
      <Root
        data-slot="page"
        data-width={width}
        data-density={density}
        className={cn('w-full min-w-0 px-(--if-gutter) text-fg', density === 'dense' ? 'py-4' : 'py-6', widthClass[width], className)}
        {...(props as React.ComponentProps<'div'>)}
      >
        {children}
      </Root>
    </PageDensityContext.Provider>
  );
}

export interface BreadcrumbItem {
  label: string;
  /** Leave out for the current page, or for a step that is not a link. */
  href?: string;
}

export interface BreadcrumbsProps extends Omit<React.ComponentProps<'nav'>, 'children'> {
  items: BreadcrumbItem[];
  /** Accessible name of the landmark. */
  label?: string;
}

/** Trail of where the person is. The last item is the current page (`aria-current="page"`); separators are hidden from screen readers. */
export function Breadcrumbs({ items, label = 'Breadcrumb', className, ...props }: BreadcrumbsProps) {
  return (
    <nav data-slot="breadcrumbs" aria-label={label} className={cn('min-w-0 text-sm text-fg-2', className)} {...props}>
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          const text = 'block max-w-[24ch] truncate';
          return (
            <li key={`${i}-${item.label}`} className="flex min-w-0 items-center gap-1.5">
              {item.href && !last ? (
                <a href={item.href} title={item.label} className={cn(text, 'rounded-xs text-fg-2 hover:text-fg', focusRing)}>
                  {item.label}
                </a>
              ) : (
                <span title={item.label} aria-current={last ? 'page' : undefined} className={cn(text, last ? 'text-fg' : 'text-fg-2')}>
                  {item.label}
                </span>
              )}
              {last ? null : (
                <span data-slot="breadcrumbs-separator" aria-hidden="true" className="flex shrink-0 text-fg-3">
                  <ChevronRight size={14} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface PageHeaderProps extends Omit<React.ComponentProps<'header'>, 'title'> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Slot above the title, normally `<Breadcrumbs />`. */
  breadcrumbs?: React.ReactNode;
  /** Right-aligned; wraps under the title on narrow widths. */
  actions?: React.ReactNode;
  /** Under the title: freshness chips, status tags. */
  meta?: React.ReactNode;
  /** Hairline under the whole header. */
  divider?: boolean;
  /** Title is a skeleton of the exact final height (28 px), nothing jumps. The title text is not rendered. */
  loading?: boolean;
  /** Default 1. */
  headingLevel?: HeadingLevel;
  density?: Density;
}

/** Title bar of a page. */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  meta,
  divider = false,
  loading = false,
  headingLevel = 1,
  density: densityProp,
  className,
  ...props
}: PageHeaderProps) {
  const inherited = React.useContext(PageDensityContext);
  const density = densityProp ?? inherited;
  const Heading = `h${headingLevel}` as 'h1';
  return (
    <header
      data-slot="page-header"
      data-density={density}
      data-loading={loading ? 'true' : undefined}
      aria-busy={loading ? 'true' : undefined}
      className={cn('flex flex-col', density === 'dense' ? 'gap-2 pb-3' : 'gap-3 pb-4', divider && 'border-b border-line', className)}
      {...props}
    >
      {breadcrumbs ? <div data-slot="page-header-breadcrumbs">{breadcrumbs}</div> : null}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          {loading ? (
            <>
              {/* Not a heading while loading: an empty heading is announced as nothing. */}
              <div data-slot="page-header-title" className="m-0 h-7">
                <Skeleton height={28} width="40%" className="min-w-40" />
              </div>
              {description ? <Skeleton height={20} width="60%" className="min-w-56" /> : null}
            </>
          ) : (
            <>
              <Heading data-slot="page-header-title" className="m-0 text-xl font-semibold text-fg">
                {title}
              </Heading>
              {description ? (
                <p data-slot="page-header-description" className={cn('m-0 text-fg-2', density === 'dense' ? 'text-sm' : 'text-base')}>
                  {description}
                </p>
              ) : null}
            </>
          )}
          {meta && !loading ? (
            <div data-slot="page-header-meta" className="flex flex-wrap items-center gap-2 pt-1 text-xs text-fg-2">
              {meta}
            </div>
          ) : null}
        </div>
        {actions && !loading ? (
          <div data-slot="page-header-actions" className="flex flex-wrap items-center gap-2 sm:justify-end">
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}

export interface PageBodyProps extends React.ComponentProps<'div'> {
  density?: Density;
}

/** Column under the header; spaces its children (sections) 16 px apart dense, 32 px comfortable. */
export function PageBody({ density: densityProp, className, ...props }: PageBodyProps) {
  const inherited = React.useContext(PageDensityContext);
  const density = densityProp ?? inherited;
  return (
    <div
      data-slot="page-body"
      data-density={density}
      className={cn('flex min-w-0 flex-col', density === 'dense' ? 'gap-4 pt-3' : 'gap-8 pt-4', className)}
      {...props}
    />
  );
}

export interface PageSectionProps extends Omit<React.ComponentProps<'section'>, 'title'> {
  title: React.ReactNode;
  /** Right-aligned in the title row (a link, a small button). */
  actions?: React.ReactNode;
  /** Default 2. */
  headingLevel?: HeadingLevel;
  density?: Density;
}

/** Titled block with a hairline under its title row. Gap to the content: 12 px dense, 24 px comfortable. */
export function PageSection({ title, actions, headingLevel = 2, density: densityProp, className, children, ...props }: PageSectionProps) {
  const inherited = React.useContext(PageDensityContext);
  const density = densityProp ?? inherited;
  const titleId = React.useId();
  const Heading = `h${headingLevel}` as 'h2';
  return (
    <section
      data-slot="page-section"
      data-density={density}
      aria-labelledby={titleId}
      className={cn('flex min-w-0 flex-col', density === 'dense' ? 'gap-3' : 'gap-6', className)}
      {...props}
    >
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line',
          density === 'dense' ? 'pb-2' : 'pb-3',
        )}
      >
        <Heading
          id={titleId}
          data-slot="page-section-title"
          className={cn('m-0 min-w-0 font-semibold text-fg', density === 'dense' ? 'text-base' : 'text-md')}
        >
          {title}
        </Heading>
        {actions ? (
          <div data-slot="page-section-actions" className="flex flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  );
}
