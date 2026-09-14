/**
 * Escape one CSV cell for the audit-log export.
 *
 * Two concerns, in order:
 * 1. Formula injection: a cell whose text begins with `=`, `+`, `-`, or `@` is evaluated as a
 *    formula when the export is opened in a spreadsheet (Excel/LibreOffice/Sheets). Audit rows
 *    carry attacker-influenced strings (request paths, error messages, API-key names), so a
 *    logged request like `GET /=HYPERLINK("https://evil…")` would become a live formula in the
 *    operator's spreadsheet. Neutralize by prefixing an apostrophe — the spreadsheet then shows
 *    the value as text. This mangles the export only (the dashboard UI shows the raw value).
 * 2. Structural quoting (pre-existing rule): a value containing `"`, `,` or a newline is
 *    wrapped in double quotes with inner quotes doubled.
 */
export function escapeCsvCell(value: unknown): string {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Render rows as CSV, in the column order given.
 *
 * Every cell goes through {@link escapeCsvCell}, so the formula-injection guard applies to any
 * export built with this — not only the audit log it was originally written for.
 */
export function toCsv<T extends Record<string, unknown>>(rows: T[], columns: Array<keyof T & string>): string {
  const header = columns.map(escapeCsvCell).join(',');
  const lines = rows.map(row => columns.map(column => escapeCsvCell(row[column])).join(','));
  return [header, ...lines].join('\n');
}

/**
 * Save a CSV string to the visitor's machine.
 *
 * The object URL is revoked on the next tick rather than immediately: Safari has historically
 * cancelled the download when the URL is revoked in the same synchronous block as the click.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
