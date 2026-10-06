import { inflateRawSync, inflateSync } from "node:zlib";

/**
 * Text extraction — pure, dependency-free, bounded.
 *
 *  - TXT, CSV, HTML, structured records (JSON): native.
 *  - DOCX, PPTX, XLSX: Office Open XML packages, read with a minimal ZIP
 *    reader (stored + deflate entries) and the documents' XML.
 *  - PDF: best effort — text-showing operators (Tj, TJ, ', ") in plain or
 *    Flate-compressed content streams. No OCR, no CID font decoding: scanned
 *    or exotic PDFs extract little or nothing and are reported as such.
 *
 * Inputs are capped (MAX_INPUT_BYTES, MAX_TEXT_CHARS) and ZIP entries are
 * capped on inflated size to resist decompression bombs.
 */
export const FORMATS = ["txt", "csv", "html", "json", "pdf", "docx", "pptx", "xlsx"] as const;
export type DocFormat = (typeof FORMATS)[number];
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_CHARS = 2_000_000;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

export interface Extraction {
  text: string;
  /** Heading-like section titles found, in order (used for chunk headings). */
  headings: string[];
  warnings: string[];
  metadata: Record<string, string>;
}

export function formatFromName(name: string, mime?: string | null): DocFormat | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, DocFormat> = { txt: "txt", md: "txt", text: "txt", csv: "csv", html: "html", htm: "html", json: "json", pdf: "pdf", docx: "docx", pptx: "pptx", xlsx: "xlsx" };
  if (map[ext]) return map[ext]!;
  const m = (mime ?? "").toLowerCase();
  if (m.includes("pdf")) return "pdf";
  if (m.includes("wordprocessingml")) return "docx";
  if (m.includes("presentationml")) return "pptx";
  if (m.includes("spreadsheetml")) return "xlsx";
  if (m.includes("html")) return "html";
  if (m.includes("csv")) return "csv";
  if (m.includes("json")) return "json";
  if (m.startsWith("text/")) return "txt";
  return null;
}

const decodeEntities = (s: string) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&");

const tidy = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT_CHARS);

// ── HTML ────────────────────────────────────────────────────────────────────
export function htmlToText(html: string): Extraction {
  const headings: string[] = [];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let s = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, _l, inner: string) => {
    const t = decodeEntities(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (t) headings.push(t);
    return `\n\n# ${t}\n\n`;
  });
  s = s.replace(/<(br|\/p|\/div|\/li|\/tr|\/section|\/article|\/h[1-6])[^>]*>/gi, "\n").replace(/<li[^>]*>/gi, "\n- ").replace(/<\/t[dh]>/gi, " | ");
  s = decodeEntities(s.replace(/<[^>]+>/g, " "));
  return { text: tidy(s), headings, warnings: [], metadata: title ? { title: decodeEntities(title).trim() } : {} };
}

// ── CSV / JSON ──────────────────────────────────────────────────────────────
export function parseCsv(input: string, maxRows = 20000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (q) {
      if (c === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x.length)) rows.push(row);
      row = [];
      if (rows.length >= maxRows) break;
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); if (row.some((x) => x.length)) rows.push(row); }
  return rows;
}

/** Tabular data as "header: value" lines per row, so each row reads as a self-contained statement. */
export function tableToText(rows: string[][]): string {
  if (!rows.length) return "";
  const [head, ...body] = rows;
  if (!body.length) return head!.join(", ");
  return body.map((r) => head!.map((h, i) => (r[i] !== undefined && r[i] !== "" ? `${h.trim() || `Column ${i + 1}`}: ${r[i]!.trim()}` : null)).filter(Boolean).join("; ")).join("\n");
}

export function recordToText(value: unknown, depth = 0, prefix = ""): string {
  if (depth > 6) return "";
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return `${prefix}${String(value)}`;
  if (Array.isArray(value)) return value.slice(0, 5000).map((v) => recordToText(v, depth + 1, prefix)).filter(Boolean).join("\n");
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => (typeof v === "object" && v !== null ? `${prefix}${k}:\n${recordToText(v, depth + 1, `${prefix}  `)}` : `${prefix}${k}: ${String(v)}`)).join("\n");
}

// ── ZIP (for OOXML) ─────────────────────────────────────────────────────────
export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Not a ZIP package (no end-of-central-directory record).");
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < Math.min(entries, 5000); n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt ZIP central directory.");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + elen + clen;
    if (usize > MAX_ENTRY_BYTES || (total += usize) > MAX_ENTRY_BYTES * 2) throw new Error("ZIP package is too large when inflated.");
    if (!/\.xml$|\.rels$/.test(name)) continue;
    const lnlen = buf.readUInt16LE(local + 26);
    const lelen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }));
  }
  return out;
}

const xmlText = (xml: string) => decodeEntities(xml.replace(/<[^>]+>/g, ""));

export function docxToText(buf: Buffer): Extraction {
  const files = readZip(buf);
  const doc = files.get("word/document.xml")?.toString("utf8");
  if (!doc) throw new Error("DOCX package has no word/document.xml.");
  const headings: string[] = [];
  const paras = doc.split(/<\/w:p>/).map((p) => {
    const t = [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((m) => (m[1] !== undefined ? m[1] : m[0] === "<w:tab/>" ? "\t" : "\n")).join("");
    const text = decodeEntities(t).trim();
    if (text && /<w:pStyle w:val="(Heading\d|Title)"/.test(p)) {
      headings.push(text);
      return `# ${text}`;
    }
    return text;
  });
  const core = files.get("docProps/core.xml")?.toString("utf8") ?? "";
  const title = /<dc:title>([^<]*)<\/dc:title>/.exec(core)?.[1];
  return { text: tidy(paras.filter(Boolean).join("\n\n")), headings, warnings: [], metadata: title ? { title: decodeEntities(title) } : {} };
}

export function pptxToText(buf: Buffer): Extraction {
  const files = readZip(buf);
  const slides = [...files.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  if (!slides.length) throw new Error("PPTX package has no slides.");
  const headings: string[] = [];
  const parts = slides.map((k, i) => {
    const xml = files.get(k)!.toString("utf8");
    const paras = xml.split(/<\/a:p>/).map((p) => xmlText([...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join("")).trim()).filter(Boolean);
    const title = paras[0] ?? `Slide ${i + 1}`;
    headings.push(title);
    return `# Slide ${i + 1}: ${title}\n\n${paras.slice(1).join("\n")}`;
  });
  return { text: tidy(parts.join("\n\n")), headings, warnings: [], metadata: {} };
}

export function xlsxToText(buf: Buffer): Extraction {
  const files = readZip(buf);
  const sharedXml = files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const shared = sharedXml.split(/<\/si>/).map((si) => xmlText([...si.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => m[1]).join("")));
  const wb = files.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const names = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => decodeEntities(m[1]!));
  const sheets = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  if (!sheets.length) throw new Error("XLSX package has no worksheets.");
  const headings: string[] = [];
  const parts = sheets.map((k, i) => {
    const xml = files.get(k)!.toString("utf8");
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of r[1]!.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!;
        const col = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "";
        const idx = col.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const v = /<v>([^<]*)<\/v>/.exec(c[2] ?? "")?.[1] ?? /<t[^>]*>([^<]*)<\/t>/.exec(c[2] ?? "")?.[1] ?? "";
        const val = /t="s"/.test(attrs) ? (shared[Number(v)] ?? "") : decodeEntities(v);
        if (idx >= 0) cells[idx] = val;
      }
      rows.push(Array.from(cells, (x) => x ?? ""));
      if (rows.length > 20000) break;
    }
    const name = names[i] ?? `Sheet ${i + 1}`;
    headings.push(name);
    return `# ${name}\n\n${tableToText(rows)}`;
  });
  return { text: tidy(parts.join("\n\n")), headings, warnings: [], metadata: {} };
}

// ── PDF (best effort) ───────────────────────────────────────────────────────
function pdfString(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) => ({ n: "\n", r: "\r", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" } as Record<string, string>)[e] ?? String.fromCharCode(parseInt(e, 8)));
}

export function pdfToText(buf: Buffer): Extraction {
  const raw = buf.toString("latin1");
  if (!raw.startsWith("%PDF")) throw new Error("Not a PDF file.");
  const warnings: string[] = [];
  const out: string[] = [];
  const streamRe = /<<([\s\S]*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = streamRe.exec(raw)) && n++ < 5000) {
    const dict = m[1]!;
    if (/\/Subtype\s*\/Image|\/Type\s*\/XObject/.test(dict)) continue;
    let content = m[2]!;
    if (/\/FlateDecode/.test(dict)) {
      try {
        content = inflateSync(Buffer.from(content, "latin1"), { maxOutputLength: MAX_ENTRY_BYTES }).toString("latin1");
      } catch {
        continue;
      }
    } else if (/\/Filter/.test(dict)) continue;
    if (!/T[Jj*']|"/.test(content)) continue;
    const lines: string[] = [];
    for (const t of content.matchAll(/\[((?:\([^)]*(?:\\\)[^)]*)*\)|[^\]])*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")|(T\*|ET|Td|TD)/g)) {
      if (t[1] !== undefined) lines.push([...t[1].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((x) => pdfString(x[1]!)).join(""));
      else if (t[2] !== undefined) lines.push(pdfString(t[2]));
      else lines.push("\n");
    }
    out.push(lines.join("").replace(/\n+/g, "\n"));
  }
  const text = tidy(out.join("\n"));
  if (text.replace(/\s/g, "").length < 20) warnings.push("Little or no text could be extracted (scanned image or unsupported font encoding). OCR is not available.");
  return { text, headings: [], warnings, metadata: {} };
}

export function extract(format: DocFormat, input: Buffer | string): Extraction {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  if (buf.length > MAX_INPUT_BYTES) throw new Error(`File exceeds ${MAX_INPUT_BYTES / 1024 / 1024} MB.`);
  const asText = () => buf.toString("utf8").replace(/^\uFEFF/, "");
  switch (format) {
    case "txt": {
      const text = asText();
      return { text: tidy(text), headings: [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((h) => h[1]!.trim()), warnings: [], metadata: {} };
    }
    case "csv":
      return { text: tidy(tableToText(parseCsv(asText()))), headings: [], warnings: [], metadata: {} };
    case "html":
      return htmlToText(asText());
    case "json": {
      let v: unknown;
      try {
        v = JSON.parse(asText());
      } catch {
        throw new Error("Invalid JSON.");
      }
      return { text: tidy(recordToText(v)), headings: [], warnings: [], metadata: {} };
    }
    case "docx":
      return docxToText(buf);
    case "pptx":
      return pptxToText(buf);
    case "xlsx":
      return xlsxToText(buf);
    case "pdf":
      return pdfToText(buf);
  }
}
