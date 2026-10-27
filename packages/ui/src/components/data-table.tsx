import type { ReactNode } from 'react';

/** Semantic, horizontally scrollable table using the Money activity list's quiet row treatment. */
export function DataTable({ headers, children, label }: { headers: readonly ReactNode[]; children: ReactNode; label: string }) {
  return (
    <div
      data-slot="data-table"
      className="w-full overflow-x-auto rounded-md focus-visible:outline-2 focus-visible:outline-focus"
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      <table className="w-full border-collapse text-left text-base [&_th]:whitespace-nowrap [&_th]:px-4 [&_th]:py-3 [&_th]:text-sm [&_th]:font-medium [&_th]:text-fg-2 [&_td]:border-t [&_td]:border-line [&_td]:px-4 [&_td]:py-4 [&_td]:align-top [&_tbody_tr:hover]:bg-hover">
        <thead>
          <tr>
            {headers.map((head, index) => (
              <th key={index} scope="col">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
