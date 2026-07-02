import { describe, expect, it } from "vitest";
import {
  getPublicVideoFileRoute,
  renderPublicVideoPageHtml,
} from "../../services/video-page.js";

describe("video page", () => {
  it("derives the public file route from the page path", () => {
    expect(getPublicVideoFileRoute("/media/video")).toBe("/media/video/file");
    expect(getPublicVideoFileRoute("/custom/video/")).toBe("/custom/video/file");
  });

  it("renders a public video playback page", () => {
    const html = renderPublicVideoPageHtml(
      {
        title: "Launch Demo",
        pagePath: "/media/video",
        filePath: "D:/videos/demo.mp4",
      },
      "https://qurl.example.com",
    );

    expect(html).toContain("<title>Launch Demo | LayerV</title>");
    expect(html).toContain('rel="canonical" href="https://qurl.example.com/media/video"');
    expect(html).toContain('src="https://qurl.example.com/media/video/file"');
    expect(html).toContain("demo.mp4");
    expect(html).toContain("Public Video Playback");
  });
});
