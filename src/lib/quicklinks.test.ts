import { describe, expect, it } from "vitest";
import { isSafeLinkHref, parseQuickLinks, parseQuickLinksEnv } from "@/lib/quicklinks";

describe("isSafeLinkHref", () => {
  it("accepts http and https", () => {
    expect(isSafeLinkHref("http://jf.lan:8096")).toBe(true);
    expect(isSafeLinkHref("https://jf.example.com")).toBe(true);
  });
  it("rejects javascript:, data:, file:, and garbage", () => {
    expect(isSafeLinkHref("javascript:alert(1)")).toBe(false);
    expect(isSafeLinkHref("data:text/html,<script>")).toBe(false);
    expect(isSafeLinkHref("file:///etc/passwd")).toBe(false);
    expect(isSafeLinkHref("not a url")).toBe(false);
  });
});

describe("parseQuickLinks", () => {
  it("keeps valid entries and drops malformed/unsafe ones", () => {
    const links = parseQuickLinks([
      { label: "Jellyfin", href: "https://jf.lan" },
      { label: "Bad", href: "javascript:alert(1)" }, // unsafe scheme
      { label: "", href: "https://x.lan" }, // empty label
      { href: "https://y.lan" }, // missing label
      "nope", // not an object
    ]);
    expect(links).toEqual([{ label: "Jellyfin", href: "https://jf.lan" }]);
  });
  it("returns [] for a non-array", () => {
    expect(parseQuickLinks({})).toEqual([]);
    expect(parseQuickLinks(null)).toEqual([]);
  });
});

describe("parseQuickLinksEnv", () => {
  it("parses a JSON string", () => {
    const json = '[{"label":"Sonarr","href":"https://sonarr.lan"}]';
    expect(parseQuickLinksEnv(json)).toEqual([{ label: "Sonarr", href: "https://sonarr.lan" }]);
  });
  it("returns [] for empty or invalid JSON", () => {
    expect(parseQuickLinksEnv(undefined)).toEqual([]);
    expect(parseQuickLinksEnv("")).toEqual([]);
    expect(parseQuickLinksEnv("{ not json")).toEqual([]);
  });
});
