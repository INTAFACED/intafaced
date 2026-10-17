'use client';

/** Downloads a CSV the server already built, exactly as shown (with generated-at and as-of lines). Nothing is fetched. */
export function CsvButton({ csv, filename, count }: { csv: string; filename: string; count: number }) {
  function download() {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <button
      type="button"
      className="mp-btn"
      onClick={download}
      disabled={count === 0}
      title={count === 0 ? 'Nothing to export.' : undefined}
    >
      Export CSV ({count})
    </button>
  );
}
