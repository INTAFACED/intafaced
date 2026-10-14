/** A refused or failed block sits in the left-aligned column, not centred as it would in a page of its own (critic M7). */
export const STATE_IN_COLUMN = 'items-start px-0 py-4 text-left';

/**
 * Skeletons inside a panel use the field colour: the kit's own skeleton colour is the panel colour, so inside a
 * panel they were invisible (critic M4). A kit utility class beats this file's CSS layer, so it is a class.
 */
export const IN_PANEL = 'bg-field';
