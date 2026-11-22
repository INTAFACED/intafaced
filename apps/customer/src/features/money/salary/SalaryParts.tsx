import type { ReactNode } from 'react';
import { EmptyState } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import type { Resource } from '../../../shared/resource';
import { SalaryFailure } from './SalaryFailure';

/**
 * The salary room's drawing of `ResourceView`, `Section` and `NoRows` (../components.tsx, which other rooms still
 * draw): the same states and words, in the Volt kit.
 */
export function Loaded<T>({ resource, reload, children }: { resource: Resource<T>; reload: () => void; children: (data: T) => ReactNode }) {
  if (resource.status === 'loading') return <Skeleton shape="rows" />;
  if (resource.status === 'failed') return <SalaryFailure result={resource.failure} retry={reload} />;
  return <>{children(resource.data)}</>;
}

export function Part({ title, description, children }: { title: ReactNode; description?: string; children: ReactNode }) {
  return (
    <section>
      <header>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </header>
      {children}
    </section>
  );
}

export function NoRows({ title }: { title: string }) {
  return <EmptyState title={title} />;
}
