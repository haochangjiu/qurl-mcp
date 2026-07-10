declare module "pdfkit" {
  interface PDFDocumentOptions {
    autoFirstPage?: boolean;
    margin?: number;
    size?: string | [number, number];
  }

  interface TextOptions {
    align?: "left" | "center" | "right" | "justify";
    lineGap?: number;
  }

  export default class PDFDocument {
    constructor(options?: PDFDocumentOptions);
    info: Record<string, string | undefined>;
    on(event: "error", listener: (error: Error) => void): this;
    pipe(destination: import("node:stream").Writable): import("node:stream").Writable;
    font(path: string): this;
    fontSize(size: number): this;
    text(text: string, options?: TextOptions): this;
    end(): void;
  }
}
