import { useState } from 'react';
import { AssetIcon, Segmented } from '@intafaced/ui/lit';
import { RoomBar, SectionTabs } from '@intafaced/ui/lit/templates';

const RANGES = ['1D', '1W', '1M', '6M', '1Y', 'All'] as const;
type Range = (typeof RANGES)[number];
const RANGE_NAMES: Record<Range, string> = {
  '1D': 'One day',
  '1W': 'One week',
  '1M': 'One month',
  '6M': 'Six months',
  '1Y': 'One year',
  All: 'All time',
};

/**
 * The coin page's two parts: its bar (a TEST coin's name and sections), which in a room stays under the top bar while
 * the page scrolls, and its range pills, pressed buttons the arrow keys move between.
 */
export function RoomBarAndRanges() {
  const [section, setSection] = useState<'overview' | 'about'>('overview');
  const [range, setRange] = useState<Range>('1D');
  return (
    <div className="vk-grid">
      <RoomBar marks={{ 'data-testid': 'kit-room-bar' }}>
        <span className="vk-row">
          <AssetIcon asset="BTC" size="lg" />
          <span>TEST Bitcoin</span>
          <span className="vk-type__micro">BTC</span>
        </span>
        <SectionTabs
          label="TEST coin sections"
          items={[
            { value: 'overview', label: 'Overview' },
            { value: 'about', label: 'About' },
          ]}
          value={section}
          onChange={setSection}
        />
      </RoomBar>
      <Segmented
        label="TEST chart range"
        marks={{ 'data-testid': 'kit-ranges' }}
        options={RANGES.map((r) => ({ value: r, label: r, name: RANGE_NAMES[r] }))}
        value={range}
        onChange={setRange}
      />
    </div>
  );
}
