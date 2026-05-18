import { describe, it, expect, afterEach } from "vitest";
import { getUpdateInfoFromWindow } from "../../src/viewer/window-globals.js";

/**
 * getUpdateInfoFromWindow reads window.__NUTRIENT_UPDATE__ — injected by the
 * server only when a newer release exists. The accessor validates the shape
 * defensively so a malformed injection can never crash the toast renderer.
 */
describe("getUpdateInfoFromWindow", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  function setGlobal(value: unknown): void {
    (globalThis as { window: Record<string, unknown> }).window = {
      __NUTRIENT_UPDATE__: value
    };
  }

  it("returns the parsed info when the global is well-formed", () => {
    setGlobal({
      currentVersion: "1.1.0",
      latestVersion: "1.3.0",
      downloadUrl: "https://nutrient.io/claude-desktop"
    });
    expect(getUpdateInfoFromWindow()).toEqual({
      currentVersion: "1.1.0",
      latestVersion: "1.3.0",
      downloadUrl: "https://nutrient.io/claude-desktop"
    });
  });

  it("returns undefined when the global is absent", () => {
    (globalThis as { window: Record<string, unknown> }).window = {};
    expect(getUpdateInfoFromWindow()).toBeUndefined();
  });

  it("returns undefined for a malformed global (missing fields)", () => {
    setGlobal({ latestVersion: "1.3.0" });
    expect(getUpdateInfoFromWindow()).toBeUndefined();
  });

  it("returns undefined when the global is not an object", () => {
    setGlobal("1.3.0");
    expect(getUpdateInfoFromWindow()).toBeUndefined();
  });
});
