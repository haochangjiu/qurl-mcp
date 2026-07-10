import PDFDocument from "pdfkit";
import { createWriteStream, existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const bundledFontPath = fileURLToPath(
  new URL("../../assets/fonts/NotoSansSC-VF.ttf", import.meta.url),
);

function ensurePdfFileName(input: string | undefined): string {
  const baseName = basename((input ?? "content").trim()) || "content";
  if (baseName.toLowerCase().endsWith(".pdf")) return baseName;
  const withoutExt = baseName.replace(/\.[^.]+$/, "");
  return `${withoutExt || "content"}.pdf`;
}

function resolveFontPath(): string | undefined {
  return existsSync(bundledFontPath) ? bundledFontPath : undefined;
}

export async function createTextPdfTempFile(input: {
  content: string;
  fileName?: string;
  title?: string;
}): Promise<{
  cleanup: () => Promise<void>;
  fileName: string;
  filePath: string;
  sizeBytes: number;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "qurl-text-pdf-"));
  const fileName = ensurePdfFileName(input.fileName);
  const filePath = join(tempDir, fileName);
  const fontPath = resolveFontPath();

  try {
    await new Promise<void>((resolve, reject) => {
      const doc = new PDFDocument({
        autoFirstPage: true,
        margin: 56,
        size: "A4",
      });
      const stream = createWriteStream(filePath);

      stream.on("finish", resolve);
      stream.on("error", reject);
      doc.on("error", reject);

      doc.pipe(stream);
      doc.info.Title = input.title ?? fileName;
      if (fontPath) {
        doc.font(fontPath);
      }
      doc.fontSize(12);
      doc.text(input.content, {
        align: "left",
        lineGap: 4,
      });
      doc.end();
    });

    const fileStat = await stat(filePath);

    return {
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
      fileName,
      filePath,
      sizeBytes: fileStat.size,
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}
