import PDFDocument from "pdfkit";
import { createWriteStream, existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const bundledFontPath = fileURLToPath(
  new URL("../../assets/fonts/NotoSansSC-VF.ttf", import.meta.url),
);

function sanitizePdfText(input: string, fallback: string): string {
  let sanitized = "";
  let replacingControlCharacters = false;
  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControlCharacter = codePoint <= 31 || codePoint === 127;
    if (isControlCharacter) {
      if (!replacingControlCharacters) sanitized += " ";
    } else {
      sanitized += character;
    }
    replacingControlCharacters = isControlCharacter;
  }
  return sanitized.trim() || fallback;
}

function ensurePdfFileName(input: string | undefined): string {
  const baseName = basename(sanitizePdfText(input ?? "content", "content")) || "content";
  if (baseName.toLowerCase().endsWith(".pdf")) return baseName;
  const withoutExt = baseName.replace(/\.[^.]+$/, "");
  return `${withoutExt || "content"}.pdf`;
}

export function resolveFontPath(candidatePath = bundledFontPath): string | undefined {
  if (existsSync(candidatePath)) return candidatePath;
  console.warn(
    "[text-pdf] bundled Noto Sans SC font is missing; falling back to Helvetica with limited CJK coverage",
  );
  return undefined;
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
      let settled = false;

      const succeed = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        stream.removeAllListeners("finish");
        if (stream.closed) {
          doc.removeAllListeners();
          if (!doc.destroyed) doc.destroy();
          reject(error);
          return;
        }
        stream.once("close", () => reject(error));
        if (!stream.destroyed) stream.destroy();
        doc.removeAllListeners();
        if (!doc.destroyed) doc.destroy();
      };

      stream.once("finish", succeed);
      stream.once("error", fail);
      doc.once("error", fail);

      try {
        doc.pipe(stream);
        doc.info.Title = sanitizePdfText(input.title ?? fileName, fileName);
        if (fontPath) {
          doc.font(fontPath);
        }
        doc.fontSize(12);
        doc.text(input.content, {
          align: "left",
          lineGap: 4,
        });
        doc.end();
      } catch (error) {
        fail(error);
      }
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
