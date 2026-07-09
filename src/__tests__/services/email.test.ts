import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nodemailerMocks = vi.hoisted(() => {
  const sendMail = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail }));
  return { sendMail, createTransport };
});

vi.mock("nodemailer", () => ({
  default: {
    createTransport: nodemailerMocks.createTransport,
  },
}));

import { sendEmailMessage } from "../../services/email.js";

describe("sendEmailMessage", () => {
  const originalConfigPath = process.env.QURL_MCP_CONFIG;
  const originalSmtpHost = process.env.QURL_SMTP_HOST;
  const originalSmtpPort = process.env.QURL_SMTP_PORT;
  const originalSmtpSecure = process.env.QURL_SMTP_SECURE;
  const originalSmtpUsername = process.env.QURL_SMTP_USERNAME;
  const originalSmtpPassword = process.env.QURL_SMTP_PASSWORD;
  const originalSmtpFromEmail = process.env.QURL_SMTP_FROM_EMAIL;
  const originalSmtpFromName = process.env.QURL_SMTP_FROM_NAME;
  let tempDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.QURL_SMTP_HOST;
    delete process.env.QURL_SMTP_PORT;
    delete process.env.QURL_SMTP_SECURE;
    delete process.env.QURL_SMTP_USERNAME;
    delete process.env.QURL_SMTP_PASSWORD;
    delete process.env.QURL_SMTP_FROM_EMAIL;
    delete process.env.QURL_SMTP_FROM_NAME;
    tempDir = mkdtempSync(join(tmpdir(), "qurl-email-test-"));
  });

  afterEach(() => {
    process.env.QURL_MCP_CONFIG = originalConfigPath;
    process.env.QURL_SMTP_HOST = originalSmtpHost;
    process.env.QURL_SMTP_PORT = originalSmtpPort;
    process.env.QURL_SMTP_SECURE = originalSmtpSecure;
    process.env.QURL_SMTP_USERNAME = originalSmtpUsername;
    process.env.QURL_SMTP_PASSWORD = originalSmtpPassword;
    process.env.QURL_SMTP_FROM_EMAIL = originalSmtpFromEmail;
    process.env.QURL_SMTP_FROM_NAME = originalSmtpFromName;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("skips delivery when SMTP is not configured", async () => {
    const configPath = join(tempDir!, "qurl-mcp.http.json");
    writeFileSync(configPath, JSON.stringify({ defaultQurlApiUrl: "https://api.layerv.ai" }));
    process.env.QURL_MCP_CONFIG = configPath;

    const result = await sendEmailMessage({
      to: ["alice@example.com"],
      subject: "Hello",
      text: "World",
    });

    expect(result).toEqual({
      attempted: false,
      enabled: false,
      recipients: ["alice@example.com"],
      skipped_reason: "SMTP is not configured.",
    });
    expect(nodemailerMocks.createTransport).not.toHaveBeenCalled();
  });

  it("sends one email per unique recipient using shared config-file SMTP settings", async () => {
    const configPath = join(tempDir!, "qurl-mcp.http.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultQurlApiUrl: "https://api.layerv.ai",
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
          fromName: "qURL",
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;
    nodemailerMocks.sendMail
      .mockResolvedValueOnce({ messageId: "msg-1" })
      .mockResolvedValueOnce({ messageId: "msg-2" });

    const result = await sendEmailMessage({
      to: ["Alice@example.com", "bob@example.com", "alice@example.com"],
      subject: "Secure link ready",
      text: "Body",
    });

    expect(nodemailerMocks.createTransport).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      auth: {
        user: "mailer",
        pass: "secret",
      },
    });
    expect(nodemailerMocks.sendMail).toHaveBeenCalledTimes(2);
    expect(nodemailerMocks.sendMail).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        from: { name: "qURL", address: "noreply@example.com" },
        to: "alice@example.com",
        subject: "Secure link ready",
      }),
    );
    expect(nodemailerMocks.sendMail).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        to: "bob@example.com",
        subject: "Secure link ready",
      }),
    );
    expect(result).toEqual({
      attempted: true,
      enabled: true,
      recipients: ["alice@example.com", "bob@example.com"],
      sent: 2,
      failed: 0,
      results: [
        {
          email: "alice@example.com",
          success: true,
          message_id: "msg-1",
        },
        {
          email: "bob@example.com",
          success: true,
          message_id: "msg-2",
        },
      ],
    });
  });
});
