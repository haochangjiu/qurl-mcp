import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTextPdfTempFile } from "../../services/text-pdf.js";

describe("createTextPdfTempFile", () => {
  it("creates a pdf, normalizes the file name, and cleans it up", async () => {
    const result = await createTextPdfTempFile({
      content: "窗前明月光",
      fileName: "note.txt",
      title: "Test PDF",
    });

    expect(result.fileName).toBe("note.pdf");
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(result.filePath)).toBe(true);

    await result.cleanup();
    expect(existsSync(result.filePath)).toBe(false);
  });

  it("ships with a bundled font asset for cross-platform rendering", () => {
    const bundledFont = resolve(process.cwd(), "assets", "fonts", "NotoSansSC-VF.ttf");
    expect(existsSync(bundledFont)).toBe(true);
  });
});
