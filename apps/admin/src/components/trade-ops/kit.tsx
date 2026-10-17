'use client';

/**
 * The UI kit parts that server pages use. The kit keeps React context inside some parts, which a server component
 * cannot load, so server pages take them from this client boundary and pass them plain data and JSX.
 */
export { Badge, EmptyState, KeyValue, PageSection } from '@intafaced/ui';
