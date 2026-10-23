'use client';

import { useState } from 'react';
import { PageSection } from './kit';
import { READ_ONLY_TEXT, type ChartOwnerValuesView } from '@/lib/trade-ops/charts-owner-values-model';
import { ChartScalarsForm } from './charts-owner-values-scalars';
import { ChartDataClassPanel } from './charts-owner-values-data-class';

/** The charts settings room: the owner counts and the data class per market, read from svc-trade and changed through the desk. */
export function ChartOwnerValuesPanel({ initial }: { initial: ChartOwnerValuesView }) {
  const [view, setView] = useState(initial);
  return (
    <div className="flex flex-col gap-6">
      {!view.canWrite ? <p className="text-sm text-fg-2">{READ_ONLY_TEXT}</p> : null}
      <PageSection title="Owner counts">
        <ChartScalarsForm view={view} onChanged={setView} />
      </PageSection>
      <PageSection title="Data class per market">
        <ChartDataClassPanel view={view} onChanged={setView} />
      </PageSection>
    </div>
  );
}
