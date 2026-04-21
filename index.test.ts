import { describe, it, expect } from "bun:test";
import { resolvePostUrl } from "./index";

// FeedItem shape (mirrors the interface in index.ts)
interface FeedItem {
  id: string;
  title?: string;
  url?: string;
  external_url?: string;
}

describe("resolvePostUrl", () => {
  it("returns the DF permalink (url) for a Linked List item that has an external_url", () => {
    const item: FeedItem = {
      id: "https://daringfireball.net/linked/2025/04/21/trump-tim-cook",
      url: "https://daringfireball.net/linked/2025/04/21/trump-tim-cook",
      external_url: "https://truthsocial.com/@realDonaldTrump/114383215449112542",
    };
    expect(resolvePostUrl(item)).toBe(
      "https://daringfireball.net/linked/2025/04/21/trump-tim-cook"
    );
  });

  it("returns the DF permalink (url) for a standalone article with no external_url", () => {
    const item: FeedItem = {
      id: "https://daringfireball.net/2025/04/some-article",
      url: "https://daringfireball.net/2025/04/some-article",
    };
    expect(resolvePostUrl(item)).toBe(
      "https://daringfireball.net/2025/04/some-article"
    );
  });

  it("falls back to id when url is absent", () => {
    const item: FeedItem = {
      id: "https://daringfireball.net/linked/2025/04/21/fallback-item",
    };
    expect(resolvePostUrl(item)).toBe(
      "https://daringfireball.net/linked/2025/04/21/fallback-item"
    );
  });

  it("never returns the external_url even when url is present", () => {
    const item: FeedItem = {
      id: "https://daringfireball.net/linked/2025/04/21/some-link",
      url: "https://daringfireball.net/linked/2025/04/21/some-link",
      external_url: "https://example.com/some-third-party-article",
    };
    const result = resolvePostUrl(item);
    expect(result).not.toBe("https://example.com/some-third-party-article");
    expect(result).toBe("https://daringfireball.net/linked/2025/04/21/some-link");
  });
});
