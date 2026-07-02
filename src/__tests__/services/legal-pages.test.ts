import { describe, expect, it } from "vitest";
import {
  findLegalDocument,
  getLegalDocuments,
  renderLegalDocumentHtml,
} from "../../services/legal-pages.js";

describe("legal pages", () => {
  it("declares the public legal routes", () => {
    expect(getLegalDocuments()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/legal/privacy", title: "Privacy Policy" }),
        expect.objectContaining({ path: "/legal/terms", title: "Terms of Service" }),
      ]),
    );
  });

  it("renders privacy policy html", () => {
    const html = renderLegalDocumentHtml("/legal/privacy", "https://qurl.example.com");
    expect(html).toContain("<title>Privacy Policy for qURL | LayerV</title>");
    expect(html).not.toContain("Canonical URL:");
    expect(html).toContain('rel="canonical" href="https://qurl.example.com/legal/privacy"');
    expect(html).toContain("privacy@layerv.ai");
  });

  it("renders terms of service html", () => {
    const html = renderLegalDocumentHtml("/legal/terms", "https://qurl.example.com");
    expect(html).toContain("<title>Terms of Service for qURL | LayerV</title>");
    expect(html).toContain("Terms of Service");
    expect(html).toContain("info@layerv.ai");
  });

  it("returns undefined for unknown routes", () => {
    expect(findLegalDocument("/legal/missing")).toBeUndefined();
    expect(renderLegalDocumentHtml("/legal/missing", "https://qurl.example.com")).toBeUndefined();
  });
});
