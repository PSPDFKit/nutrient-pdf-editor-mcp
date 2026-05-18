import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseVersion,
  isNewerVersion,
  getUpdateInfo,
  __resetUpdateCheckForTesting,
  DOWNLOAD_URL
} from "../../src/mcp/update-check.js";

describe("parseVersion", () => {
  it("parses plain and v-prefixed semver", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
  });

  it("ignores a prerelease suffix", () => {
    expect(parseVersion("v2.0.0-beta.1")).toEqual([2, 0, 0]);
  });

  it("returns null for unparseable input", () => {
    expect(parseVersion("not-a-version")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("detects a strictly newer release", () => {
    expect(isNewerVersion("1.2.0", "1.1.0")).toBe(true);
    expect(isNewerVersion("v2.0.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("1.1.1", "1.1.0")).toBe(true);
  });

  it("is false for equal or older releases", () => {
    expect(isNewerVersion("1.1.0", "1.1.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.1.0")).toBe(false);
  });

  it("is false when either side is unparseable", () => {
    expect(isNewerVersion("garbage", "1.1.0")).toBe(false);
    expect(isNewerVersion("1.2.0", "garbage")).toBe(false);
  });
});

describe("getUpdateInfo", () => {
  beforeEach(() => {
    __resetUpdateCheckForTesting();
    (globalThis as { __NUTRIENT_MCPB_VERSION__?: string }).__NUTRIENT_MCPB_VERSION__ = "1.1.0";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetUpdateCheckForTesting();
    delete (globalThis as { __NUTRIENT_MCPB_VERSION__?: string }).__NUTRIENT_MCPB_VERSION__;
  });

  it("returns update info when GitHub reports a newer release", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tag_name: "v1.3.0" }), { status: 200 })
    );
    const info = await getUpdateInfo();
    expect(info).toEqual({
      currentVersion: "1.1.0",
      latestVersion: "1.3.0",
      downloadUrl: DOWNLOAD_URL
    });
  });

  it("returns null when this bundle is already current", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tag_name: "v1.1.0" }), { status: 200 })
    );
    expect(await getUpdateInfo()).toBeNull();
  });

  it("returns null on a non-OK response (404 / rate limit)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    expect(await getUpdateInfo()).toBeNull();
  });

  it("returns null when the request throws (offline / timeout)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(await getUpdateInfo()).toBeNull();
  });

  it("caches the result — fetch runs at most once per process", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ tag_name: "v1.3.0" }), { status: 200 }));
    await getUpdateInfo();
    await getUpdateInfo();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
