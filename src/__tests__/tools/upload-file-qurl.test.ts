import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { QURLAPIError } from "../../client.js";
import { makeMockClient } from "../helpers.js";
import { uploadFileQurlSchema, uploadFileQurlTool } from "../../tools/upload-file-qurl.js";

const fixturePath = resolve("src/__tests__/fixtures/sample.pdf");

describe("uploadFileQurlTool", () => {
  const originalApiKey = process.env.QURL_API_KEY;
  const originalConnectorUrl = process.env.QURL_CONNECTOR_URL;
  const originalConfigPath = process.env.QURL_MCP_CONFIG;
  const originalFetch = globalThis.fetch;
  let tempDir: string | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.QURL_API_KEY = "lv_live_test";
    process.env.QURL_CONNECTOR_URL = "https://connector.test";
    delete process.env.QURL_MCP_CONFIG;
    tempDir = mkdtempSync(join(tmpdir(), "qurl-upload-file-test-"));
  });

  afterEach(() => {
    process.env.QURL_API_KEY = originalApiKey;
    process.env.QURL_CONNECTOR_URL = originalConnectorUrl;
    process.env.QURL_MCP_CONFIG = originalConfigPath;
    globalThis.fetch = originalFetch;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  describe("schema", () => {
    it("accepts a minimal file upload request", () => {
      const result = uploadFileQurlSchema.safeParse({ file_path: fixturePath });
      expect(result.success).toBe(true);
    });

    it("rejects unsupported content_type overrides", () => {
      const result = uploadFileQurlSchema.safeParse({
        file_path: fixturePath,
        content_type: "image/svg+xml",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler", () => {
    it("uploads the file, mints a qURL, and returns a structured result", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ resource_id: "r_upload12345" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const mintLink = vi.fn().mockResolvedValue({
        data: {
          qurl_id: "q_123456789ab",
          qurl_link: "https://qurl.link/#at_upload",
          expires_at: "2026-06-23T00:00:00Z",
          type: "transit",
        },
      });
      const getQURL = vi.fn().mockResolvedValue({
        data: {
          resource_id: "r_upload12345",
          status: "active",
          created_at: "2026-06-22T00:00:00Z",
          expires_at: "2026-06-23T00:00:00Z",
          qurl_site: "https://r_upload12345.qurl.site",
        },
      });
      const client = makeMockClient({ mintLink, getQURL });
      const tool = uploadFileQurlTool(client);

      const result = await tool.handler({ file_path: fixturePath, label: "Share PDF" });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(mintLink).toHaveBeenCalledWith(
        "r_upload12345",
        expect.objectContaining({
          label: "Share PDF",
          one_time_use: true,
        }),
      );
      expect(getQURL).toHaveBeenCalledWith("r_upload12345");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual(
        expect.objectContaining({
          resource_id: "r_upload12345",
          qurl_id: "q_123456789ab",
          qurl_link: "https://qurl.link/#at_upload",
          qurl_site: "https://r_upload12345.qurl.site",
          content_type: "application/pdf",
          file_name: "sample.pdf",
        }),
      );
      expect(tool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
    });

    it("continues when qurl_site enrichment is unavailable", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { resource_id: "r_upload12345" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = makeMockClient({
        mintLink: vi.fn().mockResolvedValue({
          data: {
            qurl_id: "q_123456789ab",
            qurl_link: "https://qurl.link/#at_upload",
            expires_at: "2026-06-23T00:00:00Z",
          },
        }),
        getQURL: vi.fn().mockRejectedValue(new Error("insufficient_scope")),
      });
      const tool = uploadFileQurlTool(client);

      const result = await tool.handler({ file_path: fixturePath });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.qurl_site).toBeUndefined();
    });

    it("returns isError when QURL_API_KEY is missing", async () => {
      delete process.env.QURL_API_KEY;
      const configPath = join(tempDir!, "qurl-mcp.config.json");
      writeFileSync(configPath, JSON.stringify({ defaultQurlApiUrl: "https://api.layerv.ai" }));
      process.env.QURL_MCP_CONFIG = configPath;
      const tool = uploadFileQurlTool(makeMockClient());

      const result = await tool.handler({ file_path: fixturePath });

      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringContaining("QURL_API_KEY is not set"),
          },
        ],
      });
    });

    it("throws a typed error when the connector upload fails", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "connector_upload_failed", detail: "upload rejected" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      );

      const tool = uploadFileQurlTool(makeMockClient());

      await expect(tool.handler({ file_path: fixturePath })).rejects.toMatchObject<QURLAPIError>({
        statusCode: 400,
        code: "connector_upload_failed",
        message: "upload rejected",
      });
    });
  });
});
