import { areaRooms } from './room';

/** The team area's rooms, in the order lookup and search meet them (`rooms` in ../navigation.ts). */
export const teamRooms = areaRooms('team', [
  { path: '/ops', title: 'Team desk', description: 'Separate operator console', area: 'team', hidden: true },
  { path: '/platform', title: 'Team inspection', description: 'Operator module inspection', area: 'team', hidden: true },
]);
