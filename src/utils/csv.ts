/**
 * Minimal CSV writer (RFC 4180) with spreadsheet formula-injection guarding.
 * Hand-rolled on purpose — first export feature in the repo; no new dependency.
 */

export type CsvValue = string | number | boolean | null | undefined

/**
 * Escape a single CSV field:
 * - null/undefined → empty string
 * - leading `=` `+` `-` `@` tab or CR gets a `'` prefix so spreadsheet apps
 *   never interpret the cell as a formula (CSV injection guard)
 * - fields containing `,` `"` newline or CR are quoted, internal quotes doubled
 */
export function escapeCsvField(value: CsvValue): string {
  if (value === null || value === undefined) return ''

  let field = String(value)

  if (/^[=+\-@\t\r]/.test(field)) {
    field = `'${field}`
  }

  if (/[",\n\r]/.test(field)) {
    field = `"${field.replace(/"/g, '""')}"`
  }

  return field
}

/** Build a CSV document: header row + data rows, CRLF line endings. */
export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [
    headers.map(escapeCsvField).join(','),
    ...rows.map((row) => row.map(escapeCsvField).join(',')),
  ]
  return lines.join('\r\n')
}
