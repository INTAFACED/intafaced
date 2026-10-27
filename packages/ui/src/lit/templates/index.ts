/**
 * `@intafaced/ui/lit/templates`: the eight templates every customer room is built from, the room frame, the legal
 * slot registry and the data shapes they take. Customer app only. CSS: `@intafaced/ui/lit/templates.css` after
 * `@intafaced/ui/lit/lit.css`.
 */
export * from './templates.js';
export { GateArea, LegalSlotsSwitch, Receipt, Review, RefusalBox, Region, RoomFrame, StateView, reviewComplete } from './frame.js';
export { RegistryLegalSlot, BAND_MOMENTS, type RegistryLegalSlotProps } from './legal/LegalSlot.js';
export { LEGAL_MOMENTS, resolveLegal, type LegalMoment, type LegalSlotType, type TextRun, type Wording } from './legal/registry.js';
export { formatMoney, isDecimal, reconcileParts, sumDecimals, sumMoney, subtractDecimals, type Part } from './money.js';
export * from './types.js';
export * from '../components/b2-basics.js';
export * from '../components/b2-charts.js';
export * from '../components/b2-table.js';
