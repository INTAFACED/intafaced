/**
 * The venue economics feature's entry: another console feature imports it only from here
 * (`garden/no-cross-feature-import`); a piece it needs that is not listed is exported here first.
 */
export { COST_AMOUNT, COST_ASSET, PERIOD, isCategory, normaliseCostAmount, type CostCategory } from './model';
