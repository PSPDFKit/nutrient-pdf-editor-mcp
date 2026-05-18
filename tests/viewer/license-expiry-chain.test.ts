import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the full license-expiry chain end-to-end:
 * SDK load rejection → overlay render → viewer_event payload composition (P2-20).
 *
 * Verifies AC4.2 (overlay + payload with default URL) and AC4.3 (URL override).
 * Server-side McpError half of AC4.3 is covered by tests/mcp/document-guard.test.ts.
 */

// ============================================================================
// Mock setup (vi.hoisted pattern copied from headless-open.test.ts)
// ============================================================================

const {
  mockLoad,
  mockUnload,
  mockCallServerTool,
  mockReadServerResource,
  mockDomState,
  mockAppRef,
  mockHostContextRef,
  mockRequestDisplayMode,
  mockSendSizeChanged,
} = vi.hoisted(() => {
  const mockDomState = {
    elements: new Map<string, any>(),
  };
  const mockAppRef: { current: any } = { current: null };
  const mockHostContextRef: { current: any } = { current: undefined };
  return {
    mockLoad: vi.fn(),
    mockUnload: vi.fn(),
    mockCallServerTool: vi.fn(),
    mockReadServerResource: vi.fn(),
    mockDomState,
    mockAppRef,
    mockHostContextRef,
    mockRequestDisplayMode: vi.fn(async () => undefined),
    mockSendSizeChanged: vi.fn(async () => undefined),
  };
});

// Mock Element class for instanceof checks
class MockElement {
  constructor(public tagName: string) {}
}

vi.stubGlobal("Element", MockElement);

vi.stubGlobal("window", {
  __NUTRIENT_ASSET_BASE__: undefined,
  __NUTRIENT_RENEWAL_URL__: undefined,
  innerWidth: 1280,
  innerHeight: 800,
});

// Mock-element factory for document.createElement. Tracks classList, setAttribute/getAttribute,
// appendChild, replaceChildren, and other properties needed by the overlay tests.
function createMockElement(tagName: string) {
  const attrs = new Map<string, string>();
  const classes = new Set<string>();

  const el: any = Object.create(MockElement.prototype);
  el.tagName = tagName.toUpperCase();
  el.className = "";
  el.textContent = "";
  el.children = [];
  el.href = "";
  el.target = "";
  el.rel = "";
  el.classList = {
    add: (cls: string) => classes.add(cls),
    contains: (cls: string) => classes.has(cls),
  };
  el.setAttribute = function (key: string, value: string) {
    attrs.set(key, value);
    // Also set property for compatibility
    if (key === "href") this.href = value;
    if (key === "target") this.target = value;
    if (key === "rel") this.rel = value;
  };
  el.getAttribute = function (key: string) {
    // Return the property value if it was set directly, otherwise check attrs map
    if (key === "href") return this.href || attrs.get(key) || null;
    if (key === "target") return this.target || attrs.get(key) || null;
    if (key === "rel") return this.rel || attrs.get(key) || null;
    return attrs.get(key) ?? null;
  };
  el.appendChild = function (child: unknown) {
    this.children.push(child);
    return child;
  };
  el.replaceChildren = vi.fn();
  el.addEventListener = vi.fn();
  return el;
}

vi.stubGlobal("document", {
  getElementById: (id: string) => mockDomState.elements.get(id) ?? null,
  createElement: vi.fn((tagName: string) => createMockElement(tagName)),
  createTextNode: vi.fn((text: string) => ({ nodeType: 3, textContent: text })),
  body: {
    get innerHTML() {
      return "";
    },
    set innerHTML(_html: string) {
      mockDomState.elements.clear();
      if (_html.includes("viewer") && !mockDomState.elements.has("viewer")) {
        const appended: unknown[] = [];
        const lecAttrs = new Map<string, string>();
        mockDomState.elements.set("viewer", {
          style: { display: "block" },
          replaceChildren: vi.fn(() => {
            appended.length = 0;
          }),
          appendChild: vi.fn((child: unknown) => {
            appended.push(child);
            return child;
          }),
          get children() {
            return appended;
          },
          classList: {
            add: (cls: string) => {},
            contains: (cls: string) => false,
          },
          setAttribute: vi.fn((key: string, value: string) => { lecAttrs.set(key, value); }),
          removeAttribute: vi.fn((key: string) => { lecAttrs.delete(key); }),
          getAttribute: vi.fn((key: string) => lecAttrs.get(key) ?? null),
        });
      }
    },
  },
});

// Mock the dynamic import of @nutrient-sdk/viewer
vi.mock("@nutrient-sdk/viewer", () => ({
  default: {
    load: mockLoad,
    unload: mockUnload,
    defaultToolbarItems: [],
  },
}));

// Mock the ext-apps App
vi.mock("@modelcontextprotocol/ext-apps", async () => {
  const actual = await vi.importActual<typeof import("@modelcontextprotocol/ext-apps")>(
    "@modelcontextprotocol/ext-apps"
  );
  return {
    ...actual,
    App: class MockApp {
      callServerTool = mockCallServerTool;
      readServerResource = mockReadServerResource;
      onhostcontextchanged: ((ctx: any) => void) | null = null;
      requestDisplayMode = mockRequestDisplayMode;
      sendSizeChanged = mockSendSizeChanged;
      constructor() {
        mockAppRef.current = this;
      }
      async connect() {
        // no-op for testing
      }
      getHostContext() {
        return mockHostContextRef.current;
      }
    },
    applyDocumentTheme: () => {},
    applyHostStyleVariables: () => {},
    applyHostFonts: () => {},
  };
});

// Import the public API after mocks
import { openDocumentFromPath, __resetForTesting } from "../../src/viewer/main.js";
import { buildExpiredRenewalMessage, LICENSE_ERROR_CODE } from "../../src/contract/viewer-errors.js";

const MOCK_INSTANCE_BASE = {
  addEventListener: () => {},
  removeEventListener: () => {},
  hasUnsavedChanges: () => false,
  exportPDF: async () => new ArrayBuffer(0),
};

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  __resetForTesting();
  mockDomState.elements.clear();
  mockLoad.mockClear();
  mockUnload.mockClear();
  mockCallServerTool.mockClear();
  mockReadServerResource.mockClear();
  mockRequestDisplayMode.mockClear();
  mockRequestDisplayMode.mockResolvedValue(undefined);
  mockSendSizeChanged.mockClear();
  mockSendSizeChanged.mockResolvedValue(undefined);

  // Default SDK load behavior (override per test)
  mockLoad.mockResolvedValue({ ...MOCK_INSTANCE_BASE, id: "mock-instance" });

  // Default document fetch
  mockReadServerResource.mockResolvedValue({
    contents: [
      {
        uri: "nutrient-doc:///current",
        mimeType: "application/octet-stream",
        blob: "SGVsbG8="
      }
    ]
  });

  // Default callServerTool behavior
  mockCallServerTool.mockResolvedValue({ structuredContent: {} });
});

describe("license-expiry-chain", () => {
  describe("AC4.2 — chain composition with default URL", () => {
    it("renders overlay with default URL and sends payload when license expires", async () => {
      // Setup: stub window without __NUTRIENT_RENEWAL_URL__ (forces fallback to default)
      vi.stubGlobal("window", {
        __NUTRIENT_ASSET_BASE__: undefined,
        __NUTRIENT_RENEWAL_URL__: undefined,
        innerWidth: 1280,
        innerHeight: 800,
      });

      // Setup #viewer element
      __resetForTesting();
      mockDomState.elements.clear();
      document.body.innerHTML = "<div id='viewer'></div>";

      // Mock SDK load to reject with expired license error
      mockLoad.mockRejectedValueOnce(new Error("License has expired"));

      // Attempt to open document
      await expect(openDocumentFromPath("/foo/bar.pdf")).rejects.toThrow(
        "License has expired"
      );

      // Assert overlay was rendered with default URL
      const viewerEl = mockDomState.elements.get("viewer")!;
      const appendedChildren = viewerEl.appendChild.mock.calls.map((call: any) => call[0]);
      const overlayContainer = appendedChildren.find((child: any) =>
        child?.classList?.contains("nutrient-license-expired-overlay")
      );

      expect(overlayContainer).toBeDefined();
      const body = overlayContainer.children[1]; // paragraph is second child
      const anchor = body.children[1]; // anchor is middle child
      expect(anchor.getAttribute("href")).toBe("https://nutrient.io/claude-desktop");

      // Assert payload was sent with correct structure and default URL
      // P2-20: viewer_event replaces submit_response + sentinel requestId
      const payloadCall = mockCallServerTool.mock.calls.find((call: any) =>
        call[0]?.name === "viewer_event" &&
        call[0]?.arguments?.event?.type === "license_error"
      );

      expect(payloadCall).toBeDefined();
      if (!payloadCall) throw new Error("unreachable: assertion above would have failed");
      const payload = payloadCall[0].arguments.event.payload;
      expect(payload.code).toBe(LICENSE_ERROR_CODE);
      expect(payload.subKind).toBe("expired");
      expect(payload.guidance).toBe(
        buildExpiredRenewalMessage("https://nutrient.io/claude-desktop")
      );
    });
  });

  describe("AC4.3 — URL override flows through to overlay and payload", () => {
    it("renders overlay with override URL and sends payload with override URL", async () => {
      // Setup: stub window WITH __NUTRIENT_RENEWAL_URL__ override
      vi.stubGlobal("window", {
        __NUTRIENT_ASSET_BASE__: undefined,
        __NUTRIENT_RENEWAL_URL__: "https://example.com/test",
        innerWidth: 1280,
        innerHeight: 800,
      });

      // Setup #viewer element
      __resetForTesting();
      mockDomState.elements.clear();
      document.body.innerHTML = "<div id='viewer'></div>";

      // Mock SDK load to reject with expired license error
      mockLoad.mockRejectedValueOnce(new Error("License has expired"));

      // Attempt to open document
      await expect(openDocumentFromPath("/foo/bar.pdf")).rejects.toThrow(
        "License has expired"
      );

      // Assert overlay was rendered with override URL
      const viewerEl = mockDomState.elements.get("viewer")!;
      const appendedChildren = viewerEl.appendChild.mock.calls.map((call: any) => call[0]);
      const overlayContainer = appendedChildren.find((child: any) =>
        child?.classList?.contains("nutrient-license-expired-overlay")
      );

      expect(overlayContainer).toBeDefined();
      const body = overlayContainer.children[1];
      const anchor = body.children[1];
      expect(anchor.getAttribute("href")).toBe("https://example.com/test");

      // Assert paragraph text contains override URL and NOT default
      const flattenedText = body.children.map((c: any) => c.textContent).join("");
      expect(flattenedText).toContain("https://example.com/test");
      expect(flattenedText).not.toContain("https://nutrient.io/claude-desktop");

      // Assert payload was sent with override URL in guidance
      // P2-20: viewer_event replaces submit_response + sentinel requestId
      const payloadCall = mockCallServerTool.mock.calls.find((call: any) =>
        call[0]?.name === "viewer_event" &&
        call[0]?.arguments?.event?.type === "license_error"
      );

      expect(payloadCall).toBeDefined();
      if (!payloadCall) throw new Error("unreachable: assertion above would have failed");
      const payload = payloadCall[0].arguments.event.payload;
      expect(payload.guidance).toBe(
        buildExpiredRenewalMessage("https://example.com/test")
      );
    });
  });

  // AC4.3 server-side McpError shape is asserted in tests/mcp/document-guard.test.ts (AC2.3).
  // This test file covers the client-side overlay and payload composition (AC4.2, AC4.3);
  // the server-side error handling and URL injection are covered there.

  describe("Non-expired license error (host-mismatch)", () => {
    it("does NOT render overlay but DOES send payload with host-mismatch subKind", async () => {
      vi.stubGlobal("window", {
        __NUTRIENT_ASSET_BASE__: undefined,
        __NUTRIENT_RENEWAL_URL__: undefined,
        innerWidth: 1280,
        innerHeight: 800,
      });

      __resetForTesting();
      mockDomState.elements.clear();
      document.body.innerHTML = "<div id='viewer'></div>";

      // Mock SDK load to reject with host-mismatch error
      mockLoad.mockRejectedValueOnce(new Error("License has invalid host: foo.com"));

      await expect(openDocumentFromPath("/foo/bar.pdf")).rejects.toThrow(
        "License has invalid host"
      );

      // Assert NO overlay container with marker class was appended
      const viewerEl = mockDomState.elements.get("viewer")!;
      const appendedChildren = viewerEl.appendChild.mock.calls.map((call: any) => call[0]);
      const hasOverlay = appendedChildren.some((child: any) =>
        child?.classList?.contains("nutrient-license-expired-overlay")
      );
      expect(hasOverlay).toBe(false);

      // Assert payload WAS sent with host-mismatch subKind
      // P2-20: viewer_event replaces submit_response + sentinel requestId
      const payloadCall = mockCallServerTool.mock.calls.find((call: any) =>
        call[0]?.name === "viewer_event" &&
        call[0]?.arguments?.event?.type === "license_error"
      );

      expect(payloadCall).toBeDefined();
      if (!payloadCall) throw new Error("unreachable: assertion above would have failed");
      const payload = payloadCall[0].arguments.event.payload;
      expect(payload.code).toBe(LICENSE_ERROR_CODE);
      expect(payload.subKind).toBe("host-mismatch");
    });
  });

  describe("Non-license error (e.g. Failed to fetch)", () => {
    it("neither renders overlay nor sends LICENSE_ERROR payload", async () => {
      vi.stubGlobal("window", {
        __NUTRIENT_ASSET_BASE__: undefined,
        __NUTRIENT_RENEWAL_URL__: undefined,
        innerWidth: 1280,
        innerHeight: 800,
      });

      __resetForTesting();
      mockDomState.elements.clear();
      document.body.innerHTML = "<div id='viewer'></div>";

      // Mock SDK load to reject with non-license error
      mockLoad.mockRejectedValueOnce(new Error("Failed to fetch"));

      await expect(openDocumentFromPath("/foo/bar.pdf")).rejects.toThrow(
        "Failed to fetch"
      );

      // Assert NO overlay container appended
      const viewerEl = mockDomState.elements.get("viewer")!;
      const appendedChildren = viewerEl.appendChild.mock.calls.map((call: any) => call[0]);
      const hasOverlay = appendedChildren.some((child: any) =>
        child?.classList?.contains("nutrient-license-expired-overlay")
      );
      expect(hasOverlay).toBe(false);

      // Assert mockCallServerTool was NOT called with a license_error viewer_event
      // P2-20: check the new viewer_event shape
      const licenseErrorCall = mockCallServerTool.mock.calls.find((call: any) =>
        call[0]?.name === "viewer_event" &&
        call[0]?.arguments?.event?.type === "license_error"
      );
      expect(licenseErrorCall).toBeUndefined();
    });
  });
});
