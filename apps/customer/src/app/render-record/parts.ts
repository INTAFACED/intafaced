import type { Part } from './harness';

/**
 * States the TEST account alone never shows, each named after the room it is drawn in. A change that only shows in one
 * of these is still a change in what a person sees.
 */
export const STATES: Part[] = [
  {
    // A standing order the bank answers with revision 0: the app refuses the list (a revision is a positive number)
    // instead of showing a row it cannot change safely.
    name: '/bank/transfers#standing-order-revision-0',
    route: '/bank/transfers',
    answer: ({ module, procedure }) =>
      module === 'bank' && procedure === 'transfers.listSchedules'
        ? {
            status: 200,
            json: {
              result: {
                data: [
                  {
                    id: 'sched_test_1',
                    assetId: 'USDC',
                    amount: '25.00',
                    cadence: 'monthly',
                    startsAt: '2026-10-01T00:00:00.000Z',
                    endsAt: null,
                    nextRunAt: '2026-11-01T00:00:00.000Z',
                    status: 'active',
                    revision: 0,
                    toSpaceId: null,
                  },
                ],
              },
            },
          }
        : null,
  },
  {
    // Every bank read meets a network that is down: what each panel of the bank room says when it cannot reach us.
    name: '/bank#network-down',
    route: '/bank',
    answer: ({ module }) => (module === 'bank' ? 'network-down' : null),
  },
];

/** A part's recording file: its route with `/` as `__`, then `--<state>` (`bank__transfers--standing-order-revision-0`). */
export function fileOf(name: string) {
  const [route, state] = name.split('#') as [string, string | undefined];
  const base = route === '/' ? 'root' : route.slice(1).replaceAll('/', '__');
  return `${base}${state ? `--${state}` : ''}.html`;
}
