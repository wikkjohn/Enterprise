import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pdfToText } from "../../modules/knowledge-verification/src/extract";

/**
 * SECURITY: document parsing (modules/knowledge-verification/src/extract.ts)
 * runs inline in the request. A crafted PDF content stream triggers
 * catastrophic backtracking in the text-operator regex (extract.ts ~235),
 * hanging the single-threaded event loop (DoS of the whole web/worker
 * process, not just one request).
 *
 * We run the vulnerable parser OUT OF PROCESS with a hard timeout so a hang
 * cannot take down the test runner. The assertion is the SECURE behaviour
 * (parsing completes well within budget), so it FAILS today.
 */
const BUDGET_MS = 4000;
const extractModule = join(process.cwd(), "modules/knowledge-verification/src/extract.ts");

// A valid-enough PDF whose (uncompressed) content stream drives the TJ-operator
// regex into catastrophic backtracking: a satisfied text op to pass the gate,
// then an unterminated "[" followed by ambiguous "(a\)" groups with no closing "]".
// Measured: ~2.5s at 18 groups, hangs past 7s by 22 on this parser.
function redosPdf(groups: number): Buffer {
  const payload = `(z)Tj [${"(a\\)".repeat(groups)}`;
  return Buffer.from(`%PDF-1.4\n<< >>\nstream\n${payload}\nendstream\n`, "latin1");
}

describe("PDF text extraction is not vulnerable to ReDoS", () => {
  it("extracts a normal PDF correctly (control)", () => {
    const pdf = Buffer.from("%PDF-1.4\n<< >>\nstream\nBT (Hello world) Tj ET\nendstream\n", "latin1");
    expect(pdfToText(pdf).text).toContain("Hello world");
  });

  it("parses a crafted content stream within a bounded time (out-of-process, hard-killed on hang)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sec-upload-"));
    const fixture = join(dir, "redos.pdf");
    writeFileSync(fixture, redosPdf(26));
    const runner = join(dir, "run.mjs");
    // tsx loads the TS module; the runner just parses the fixture and exits 0 on success.
    writeFileSync(
      runner,
      `import { readFileSync } from "node:fs";
import { pdfToText } from ${JSON.stringify(extractModule)};
pdfToText(readFileSync(process.argv[2]));
console.log("done");`,
    );

    let finished = false;
    try {
      execFileSync("pnpm", ["exec", "tsx", runner, fixture], { timeout: BUDGET_MS, stdio: "pipe", cwd: process.cwd() });
      finished = true;
    } catch {
      // ETIMEDOUT / SIGTERM means the parser hung past the budget → vulnerable.
      finished = false;
    }
    expect(finished).toBe(true);
  }, BUDGET_MS + 20_000);
});
