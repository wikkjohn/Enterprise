/**
 * Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF,
 * embedded newlines). Pure; no I/O.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i++;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      field = "";
      if (row.some((f) => f !== "") || row.length > 1) rows.push(row);
      row = [];
      i += c === "\r" && src[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (quoted) throw new Error("Unterminated quoted field");
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((f) => f !== "")) rows.push(row);
  }
  return rows;
}

/** Canonical import columns and accepted header aliases (case/space-insensitive). */
export const CSV_COLUMNS: Record<string, string[]> = {
  name: ["name", "workflow", "workflow name"],
  description: ["description"],
  department: ["department", "dept"],
  ownerName: ["owner", "process owner"],
  businessSponsor: ["sponsor", "business sponsor"],
  status: ["status"],
  frequency: ["frequency"],
  annualVolume: ["annual volume", "volume", "annual_volume"],
  systems: ["systems", "systems involved"],
  roles: ["roles", "roles involved"],
  riskCategory: ["risk", "risk category", "risk_category"],
  regulatoryCategory: ["regulatory category", "regulatory", "regulatory_category"],
  sourceRef: ["id", "external id", "source id", "ref"],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[_\s]+/g, " ");

export interface CsvMappedRow {
  line: number;
  values: Record<string, string>;
}

export function mapCsv(text: string): { rows: CsvMappedRow[]; unknownHeaders: string[] } {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], unknownHeaders: [] };
  const headers = table[0]!.map(norm);
  const index: Record<string, number> = {};
  const unknownHeaders: string[] = [];
  headers.forEach((h, i) => {
    const field = Object.entries(CSV_COLUMNS).find(([, aliases]) => aliases.map(norm).includes(h))?.[0];
    if (field) index[field] = i;
    else if (h) unknownHeaders.push(table[0]![i]!.trim());
  });
  if (index.name === undefined) throw new Error('CSV must have a "name" column');
  const rows = table.slice(1).map((cells, n) => {
    const values: Record<string, string> = {};
    for (const [field, i] of Object.entries(index)) {
      const v = cells[i]?.trim();
      if (v) values[field] = v;
    }
    return { line: n + 2, values };
  });
  return { rows, unknownHeaders };
}

/** Split a multi-value cell ("SAP; Salesforce | Excel"). */
export const splitList = (v: string | undefined) => (v ? v.split(/[;|]/).map((s) => s.trim()).filter(Boolean) : []);
