/** Escape a CSV field (RFC-style quotes when needed). */
export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Build a CSV string from a header row and data rows (all string cells). */
export function buildCsv(headers: string[], rows: string[][]): string {
  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => row.map((cell) => csvEscape(cell ?? '')).join(',')),
  ];
  return `${lines.join('\n')}\n`;
}
