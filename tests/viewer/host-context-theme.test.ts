import { describe, it, expect, vi } from "vitest";

/**
 * Tests for `nutrientThemeFromHost`: explicit host-theme → SDK-theme mapping.
 *
 * The host context theme is a strict `"light" | "dark" | undefined` union.
 * The mapping must be explicit (never the SDK's `AUTO`, which follows the OS
 * `prefers-color-scheme` rather than the host app) so the SDK chrome and the
 * `<html data-theme>` attribute (set by `applyHostContext`) stay in sync.
 */

// host-context.ts constructs `new App(...)` at module scope; stub ext-apps so
// the import is side-effect free in the test environment.
vi.mock("@modelcontextprotocol/ext-apps", async () => {
  const actual = await vi.importActual<typeof import("@modelcontextprotocol/ext-apps")>(
    "@modelcontextprotocol/ext-apps"
  );
  return {
    ...actual,
    App: class MockApp {},
    applyDocumentTheme: () => {},
    applyHostStyleVariables: () => {},
    applyHostFonts: () => {}
  };
});

const { nutrientThemeFromHost } = await import("../../src/viewer/host-context.js");

describe("nutrientThemeFromHost", () => {
  it("maps a dark host theme to the SDK DARK theme", () => {
    expect(nutrientThemeFromHost("dark")).toBe("DARK");
  });

  it("maps a light host theme to the SDK LIGHT theme", () => {
    expect(nutrientThemeFromHost("light")).toBe("LIGHT");
  });

  it("maps an absent host theme to LIGHT (the SDK default)", () => {
    expect(nutrientThemeFromHost(undefined)).toBe("LIGHT");
  });
});
