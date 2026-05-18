import { describe, it, expect } from "vitest";
import { resolveHostAppName } from "../../src/mcp/host-mapping.js";

describe("resolveHostAppName", () => {
  describe("Claude Desktop variants (case-insensitive)", () => {
    it("matches *claude* substring anywhere in the name", () => {
      expect(resolveHostAppName({ name: "claude-ai" })).toBe("com.anthropic.claude.desktop");
      expect(resolveHostAppName({ name: "claude-desktop" })).toBe(
        "com.anthropic.claude.desktop"
      );
      expect(resolveHostAppName({ name: "Claude-AI" })).toBe("com.anthropic.claude.desktop");
      expect(resolveHostAppName({ name: "CLAUDE-DESKTOP" })).toBe(
        "com.anthropic.claude.desktop"
      );
      expect(resolveHostAppName({ name: "claude-ai-fork" })).toBe(
        "com.anthropic.claude.desktop"
      );
      expect(resolveHostAppName({ name: "not-claude-ai" })).toBe(
        "com.anthropic.claude.desktop"
      );
    });

    it("matches *custom3p* substring anywhere in the name", () => {
      expect(resolveHostAppName({ name: "custom3p-main" })).toBe(
        "com.anthropic.claude.desktop"
      );
      expect(resolveHostAppName({ name: "custom3p-desktop" })).toBe(
        "com.anthropic.claude.desktop"
      );
      expect(resolveHostAppName({ name: "CUSTOM3P-main" })).toBe(
        "com.anthropic.claude.desktop"
      );
    });

    it("matches the local-agent-mode-* prefix", () => {
      expect(resolveHostAppName({ name: "local-agent-mode-Nutrient PDF Editor" })).toBe(
        "com.anthropic.claude.desktop"
      );
      expect(resolveHostAppName({ name: "local-agent-mode-x" })).toBe(
        "com.anthropic.claude.desktop"
      );
      expect(resolveHostAppName({ name: "LOCAL-AGENT-MODE-x" })).toBe(
        "com.anthropic.claude.desktop"
      );
    });
  });

  describe("absent / invalid identity", () => {
    it("returns null when clientInfo is undefined", () => {
      expect(resolveHostAppName(undefined)).toBeNull();
    });

    it("returns null when name is undefined", () => {
      expect(resolveHostAppName({})).toBeNull();
    });

    it("returns null when name is the empty string", () => {
      expect(resolveHostAppName({ name: "" })).toBeNull();
    });
  });

  describe("unknown hosts (loud-failure path)", () => {
    it("returns null for a name with no Claude / custom3p / local-agent-mode marker", () => {
      expect(resolveHostAppName({ name: "openai-codex" })).toBeNull();
      expect(resolveHostAppName({ name: "vscode-mcp-client" })).toBeNull();
    });
  });
});
