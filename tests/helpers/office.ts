import { crc32, deflateRawSync, deflateSync } from "node:zlib";

/** Minimal ZIP writer (deflate) for building OOXML test fixtures. */
export function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const n = Object.keys(files).length;
  end.writeUInt16LE(n, 8);
  end.writeUInt16LE(n, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function docx(paragraphs: Array<string | { heading: string }>, title?: string): Buffer {
  const body = paragraphs.map((p) => (typeof p === "string" ? `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>` : `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${esc(p.heading)}</w:t></w:r></w:p>`)).join("");
  return zip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ...(title ? { "docProps/core.xml": `<cp:coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title></cp:coreProperties>` } : {}),
  });
}

export function xlsx(sheetName: string, rows: string[][]): Buffer {
  const strings: string[] = [];
  const idx = (s: string) => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };
  const col = (i: number) => String.fromCharCode(65 + i);
  const rowsXml = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (/^\d+(\.\d+)?$/.test(v) ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${idx(v)}</v></c>`)).join("")}</row>`).join("");
  return zip({
    "xl/workbook.xml": `<workbook><sheets><sheet name="${esc(sheetName)}" sheetId="1"/></sheets></workbook>`,
    "xl/sharedStrings.xml": `<sst>${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${rowsXml}</sheetData></worksheet>`,
  });
}

export function pptx(slides: string[][]): Buffer {
  const files: Record<string, string> = {};
  slides.forEach((paras, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = `<p:sld><p:txBody>${paras.map((p) => `<a:p><a:r><a:t>${esc(p)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sld>`;
  });
  return zip(files);
}

/** A tiny one-page PDF whose content stream is Flate-compressed. */
export function pdf(lines: string[]): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td ${lines.map((l) => `(${l.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj T*`).join(" ")} ET`;
  const comp = deflateSync(Buffer.from(content, "latin1"));
  const head = "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n";
  return Buffer.concat([Buffer.from(`${head}4 0 obj << /Length ${comp.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), comp, Buffer.from("\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1")]);
}
