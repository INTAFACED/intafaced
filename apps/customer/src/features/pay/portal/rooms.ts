import { mergeRooms } from './rooms-model';
import { catalogRooms } from './catalog/rooms';
import { moneyRooms } from './money/rooms';
import { paymentsRooms } from './payments/rooms';
import { settingsRooms } from './settings/rooms';

/** The one table of portal pages. Each package registers its own; a room registered twice throws when this loads. */
export const rooms = mergeRooms(moneyRooms, paymentsRooms, settingsRooms, catalogRooms);
