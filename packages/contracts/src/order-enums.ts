/**
 * The side and time in force of an order, one list each. Contracts owns them so a call's record can name them;
 * @intafaced/exchange-contract re-exports them for the engine's own wire.
 */
import { z } from 'zod';

export const orderSideSchema = z.enum(['buy', 'sell']);
export const timeInForceSchema = z.enum(['GTC', 'IOC', 'FOK', 'PO', 'MOC', 'GTD', 'GTT']);
