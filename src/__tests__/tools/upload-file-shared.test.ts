import { describe, expect, it } from "vitest";
import { getConnectorUploadUrl } from "../../tools/upload-file-shared.js";

describe("getConnectorUploadUrl", () => {
  it("builds the fixed connector upload endpoint for HTTPS origins", () => {
    expect(getConnectorUploadUrl("https://connector.example.com")).toBe(
      "https://connector.example.com/api/upload",
    );
  });

  it("allows HTTP only for loopback development endpoints", () => {
    expect(getConnectorUploadUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/api/upload");
    expect(getConnectorUploadUrl("http://127.42.0.7:8080")).toBe(
      "http://127.42.0.7:8080/api/upload",
    );
    expect(getConnectorUploadUrl("http://2130706433:8080")).toBe(
      "http://127.0.0.1:8080/api/upload",
    );
    expect(() => getConnectorUploadUrl("http://connector.example.com")).toThrow("must use HTTPS");
  });

  it("rejects connector URLs with embedded credentials", () => {
    expect(() => getConnectorUploadUrl("https://user:pass@connector.example.com")).toThrow(
      "must not contain embedded credentials",
    );
  });

  it("preserves an operator-configured base path and rejects query or fragment suffixes", () => {
    expect(getConnectorUploadUrl("https://connector.example.com/qurl")).toBe(
      "https://connector.example.com/qurl/api/upload",
    );
    expect(() => getConnectorUploadUrl("https://connector.example.com?target=other")).toThrow(
      "must not contain a query string or fragment",
    );
    expect(() => getConnectorUploadUrl("https://connector.example.com/#other")).toThrow(
      "must not contain a query string or fragment",
    );
  });
});
