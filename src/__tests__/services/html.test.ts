import { describe, expect, it } from "vitest";
import { escapeHtml } from "../../services/html.js";

describe("HTML helpers", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("preserves plain text and handles empty input", () => {
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
    expect(escapeHtml("")).toBe("");
  });
});
