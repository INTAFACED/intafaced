import { defineCopy } from '../../shared/i18n';

const en = {
  positions: 'Predict positions',
  purchases: 'Market purchases',
  newLaunch: 'New launch',
  launchCheck: 'Launch check',
  launchRequirements: 'Launch requirements',
  governance: 'Token governance',
  economy: 'Token economy',
  workers: 'Mining workers',
  shares: 'Mining shares',
  rewards: 'Mining rewards',
  status: 'Mining status',
  crew: 'Blueprint crew',
  sharedCard: 'Shared card',
  market: 'Market listing',
  predict: 'Prediction market',
  launchProject: 'Launch project',
  proposal: 'Governance proposal',
  worker: 'Mining worker',
  detailTitle: 'No details are shown for this record',
  detailBody: 'This page has no data source: no read for this record is wired to it, so nothing about it is shown.',
  badIdTitle: 'That address is not valid',
  badIdBody: 'The id in the address is not an id this room uses, so nothing was looked up.',
  back: 'Back to the room',
  open: 'Open this room',
} as const;
export const moreRoomRoutesCopy = defineCopy('more.room.routes', en);
