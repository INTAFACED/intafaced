/**
 * Below 900 px there is no room to dock, so the same panels stack in one column, as the desk always did on a phone:
 * chart, ticket, book, trades, orders. No rail and no saved layout; nothing here touches the saved workspaces.
 */
import { getPanel } from './registry';
import { registerBuiltInPanels } from './panels';

registerBuiltInPanels();

const ORDER = ['chart', 'ticket', 'orderbook', 'trades', 'orders'] as const;

export function CompactStack() {
  return (
    <div className="tm-compact">
      {ORDER.map((type) => {
        const definition = getPanel(type);
        if (!definition) return null;
        const Panel = definition.component;
        return (
          <section key={type} className="tm-compact-item" data-type={type} aria-label={definition.title}>
            <div className="tm-panel" data-type={type}>
              <Panel visible />
            </div>
          </section>
        );
      })}
    </div>
  );
}
