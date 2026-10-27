// Tables in the running app, found the way the app's DataTable draws them: the name is on the region that holds the
// table, not on the table (as `tableIn` in agents.mjs), and body rows are the rows that hold cells, never `tbody tr`.

/** The table inside the region named `name`. */
export const tableIn = (scope, name) =>
  scope.getByRole('region', typeof name === 'string' ? { name, exact: true } : { name }).getByRole('table');

/** A table's body rows: every row with a cell, so the header row is left out. */
export const bodyRows = (table) => table.getByRole('row').filter({ has: table.page().getByRole('cell') });
