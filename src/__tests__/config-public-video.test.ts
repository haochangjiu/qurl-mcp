import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHttpServerConfig } from "../http-config.js";
import { loadRuntimeConfig } from "../config.js";

describe("public video config", () => {
  const originalConfigPath = process.env.QURL_MCP_CONFIG;
  const originalHttpConfigPath = process.env.QURL_MCP_HTTP_CONFIG;
  const originalApiKey = process.env.QURL_API_KEY;
  const originalVideoPath = process.env.QURL_PUBLIC_VIDEO_FILE_PATH;
  const originalVideoTitle = process.env.QURL_PUBLIC_VIDEO_TITLE;
  const originalVideoPagePath = process.env.QURL_PUBLIC_VIDEO_PAGE_PATH;
  let tempDir: string | undefined;

  beforeEach(() => {
    delete process.env.QURL_MCP_CONFIG;
    delete process.env.QURL_MCP_HTTP_CONFIG;
    delete process.env.QURL_API_KEY;
    delete process.env.QURL_PUBLIC_VIDEO_FILE_PATH;
    delete process.env.QURL_PUBLIC_VIDEO_TITLE;
    delete process.env.QURL_PUBLIC_VIDEO_PAGE_PATH;
    tempDir = mkdtempSync(join(tmpdir(), "qurl-video-config-test-"));
  });

  afterEach(() => {
    process.env.QURL_MCP_CONFIG = originalConfigPath;
    process.env.QURL_MCP_HTTP_CONFIG = originalHttpConfigPath;
    process.env.QURL_API_KEY = originalApiKey;
    process.env.QURL_PUBLIC_VIDEO_FILE_PATH = originalVideoPath;
    process.env.QURL_PUBLIC_VIDEO_TITLE = originalVideoTitle;
    process.env.QURL_PUBLIC_VIDEO_PAGE_PATH = originalVideoPagePath;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("loads public video config from the shared runtime config file", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultQurlApiUrl: "https://api.layerv.ai",
        publicVideo: {
          title: "Launch Demo",
          pagePath: "/media/video",
          filePath: "D:/videos/demo.mp4",
        },
      }),
    );

    const config = loadRuntimeConfig(configPath);

    expect(config.publicVideo).toEqual({
      title: "Launch Demo",
      pagePath: "/media/video",
      filePath: "D:/videos/demo.mp4",
    });
  });

  it("falls back to the HTTP config file for public video settings", () => {
    const runtimeConfigPath = join(tempDir!, "qurl-mcp.config.json");
    const httpConfigPath = join(tempDir!, "qurl-mcp.http.json");

    writeFileSync(
      runtimeConfigPath,
      JSON.stringify({
        defaultQurlApiUrl: "https://api.layerv.ai",
      }),
    );
    writeFileSync(
      httpConfigPath,
      JSON.stringify({
        port: 3000,
        host: "0.0.0.0",
        baseUrl: "https://qurl.example.com",
        publicVideo: {
          title: "Server Demo",
          pagePath: "show/video",
          filePath: "/srv/videos/demo.mp4",
        },
      }),
    );

    process.env.QURL_MCP_CONFIG = runtimeConfigPath;
    process.env.QURL_MCP_HTTP_CONFIG = httpConfigPath;

    const config = loadHttpServerConfig(httpConfigPath);

    expect(config.publicVideo).toEqual({
      title: "Server Demo",
      pagePath: "/show/video",
      filePath: "/srv/videos/demo.mp4",
    });
  });

  it("allows environment variables to override shared public video config", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultQurlApiUrl: "https://api.layerv.ai",
        publicVideo: {
          title: "Config Video",
          pagePath: "/media/video",
          filePath: "D:/videos/config.mp4",
        },
      }),
    );

    process.env.QURL_PUBLIC_VIDEO_FILE_PATH = "D:/videos/env.mp4";
    process.env.QURL_PUBLIC_VIDEO_TITLE = "Env Video";
    process.env.QURL_PUBLIC_VIDEO_PAGE_PATH = "public/watch";

    const config = loadRuntimeConfig(configPath);

    expect(config.publicVideo).toEqual({
      title: "Env Video",
      pagePath: "/public/watch",
      filePath: "D:/videos/env.mp4",
    });
  });

  it("loads the qurl API key only from the environment", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultQurlApiUrl: "https://api.layerv.ai",
      }),
    );

    process.env.QURL_API_KEY = "env-key";

    const config = loadRuntimeConfig(configPath);

    expect(config.qurlApiKey).toBe("env-key");
  });
});
