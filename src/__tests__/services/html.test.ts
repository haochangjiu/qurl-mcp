import { describe, expect, it } from "vitest";
import { escapeHtml } from "../../services/html.js";

describe("HTML helpers", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
