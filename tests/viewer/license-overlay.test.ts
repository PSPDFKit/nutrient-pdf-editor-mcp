import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for renderExpiredLicenseOverlay and catch-block wiring.
 *
 * Verifies:
 * - AC1.1: Overlay structure matches canonical copy
 * - AC1.2: Anchor attributes (href, target, rel)
 * - AC1.3: Fallback when window global is undefined/empty
 * - AC1.4: Non-license errors don't render overlay; expired errors do
 * - AC1.5: Idempotence — calling twice doesn't duplicate DOM nodes
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
        const viewerAttrs = new Map<string, string>();
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
          setAttribute: vi.fn((key: string, value: string) => { viewerAttrs.set(key, value); }),
          removeAttribute: vi.fn((key: string) => { viewerAttrs.delete(key); }),
          getAttribute: vi.fn((key: string) => viewerAttrs.get(key) ?? null),
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
import {
  renderExpiredLicenseOverlay,
  getRenewalUrlFromWindow,
  openDocumentFromPath,
  __resetForTesting,
} from "../../src/viewer/main.js";

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
  mockCallServerTool.mockClear();
  mockReadServerResource.mockClear();
});

describe("license-overlay", () => {
  describe("AC1.1: Overlay structure equals canonical copy verbatim", () => {
    it("renders heading + paragraph with anchor inline", () => {
      // Seed the #viewer element
      document.body.innerHTML = "<div id='viewer'></div>";
      const viewerEl = mockDomState.elements.get("viewer")!;

      // Call with non-default URL so the assertion can't pass on fallback
      renderExpiredLicenseOverlay("https://example.com/renew");

      // Assert replaceChildren was called once
      expect(viewerEl.replaceChildren).toHaveBeenCalledTimes(1);

      // Assert appendChild was called once (for the container)
      expect(viewerEl.appendChild).toHaveBeenCalledTimes(1);
      const container = viewerEl.appendChild.mock.calls[0][0];

      // Assert container has both classes
      expect(container.classList.contains("nutrient-viewer-fallback")).toBe(true);
      expect(container.classList.contains("nutrient-license-expired-overlay")).toBe(true);

      // Assert first child is h2 with correct text
      const heading = container.children[0];
      expect(heading.tagName).toBe("H2");
      expect(heading.textContent).toBe("Nutrient PDF Editor needs updating");

      // Assert second child is p with three children (text, anchor, text)
      const body = container.children[1];
      expect(body.tagName).toBe("P");
      expect(body.children.length).toBe(3);

      // Assert the three children are: text-node, anchor, text-node
      const [textNode1, anchor, textNode2] = body.children;
      expect((textNode1 as any).nodeType).toBe(3); // Text node
      expect((anchor as any).tagName).toBe("A");
      expect((textNode2 as any).nodeType).toBe(3); // Text node

      // Flatten the paragraph text by concatenating textContent of all children
      const flattenedText = body.children.map((c: any) => c.textContent).join("");

      // The overlay body intentionally drops the leading
      // "Nutrient PDF Editor needs updating." sentence that
      // buildExpiredRenewalMessage emits, because the heading already says it.
      // The McpError surface keeps the full helper sentence (covered by
      // tests/mcp/license-error.test.ts).
      expect(flattenedText).toBe(
        "Please check the marketplace for updates or visit https://example.com/renew for more information."
      );
    });
  });

  describe("AC1.2: Anchor attributes", () => {
    it("sets href, target=_blank, rel=noreferrer noopener", () => {
      document.body.innerHTML = "<div id='viewer'></div>";

      renderExpiredLicenseOverlay("https://example.com/renew");

      const viewerEl = mockDomState.elements.get("viewer")!;
      const container = viewerEl.appendChild.mock.calls[0][0];
      const body = container.children[1];
      const anchor = body.children[1];

      expect(anchor.tagName).toBe("A");
      expect(anchor.getAttribute("href")).toBe("https://example.com/renew");
      expect(anchor.getAttribute("target")).toBe("_blank");
      expect(anchor.getAttribute("rel")).toBe("noreferrer noopener");
    });
  });

  describe("AC1.3: Fallback when window global is undefined", () => {
    it("returns embedded fallback when __NUTRIENT_RENEWAL_URL__ is undefined", () => {
      vi.stubGlobal("window", {
        __NUTRIENT_RENEWAL_URL__: undefined,
        innerWidth: 1280,
        innerHeight: 800,
      });

      const url = getRenewalUrlFromWindow();
      expect(url).toBe("https://nutrient.io/claude-desktop");
    });

    it("returns embedded fallback when __NUTRIENT_RENEWAL_URL__ is empty string", () => {
      vi.stubGlobal("window", {
        __NUTRIENT_RENEWAL_URL__: "",
        innerWidth: 1280,
        innerHeight: 800,
      });

      const url = getRenewalUrlFromWindow();
      expect(url).toBe("https://nutrient.io/claude-desktop");
    });

    it("returns the value verbatim when __NUTRIENT_RENEWAL_URL__ is a non-empty string", () => {
      vi.stubGlobal("window", {
        __NUTRIENT_RENEWAL_URL__: "https://example.com/test",
        innerWidth: 1280,
        innerHeight: 800,
      });

      const url = getRenewalUrlFromWindow();
      expect(url).toBe("https://example.com/test");
    });

    it("renders overlay with fallback URL when global is undefined", () => {
      vi.stubGlobal("window", {
        __NUTRIENT_RENEWAL_URL__: undefined,
        innerWidth: 1280,
        innerHeight: 800,
      });

      document.body.innerHTML = "<div id='viewer'></div>";

      const url = getRenewalUrlFromWindow();
      renderExpiredLicenseOverlay(url);

      const viewerEl = mockDomState.elements.get("viewer")!;
      const container = viewerEl.appendChild.mock.calls[0][0];
      const body = container.children[1];
      const anchor = body.children[1];

      expect(anchor.getAttribute("href")).toBe("https://nutrient.io/claude-desktop");
    });
  });

  describe("AC1.4: Non-license error does NOT render overlay; expired DOES", () => {
    it("does not render overlay for non-license errors (e.g. 'Failed to fetch document')", async () => {
      // Reset and setup
      __resetForTesting();
      mockDomState.elements.clear();
      document.body.innerHTML = "<div id='viewer'></div>";

      // Setup mocks
      mockReadServerResource.mockResolvedValue({
        contents: [
          {
            uri: "nutrient-doc:///current",
            mimeType: "application/octet-stream",
            blob: "SGVsbG8=",
          },
        ],
      });

      // Make load reject with a non-license error
      mockLoad.mockRejectedValueOnce(new Error("Failed to fetch document"));

      const viewerEl = mockDomState.elements.get("viewer")!;

      // Attempt to open; this should rethrow the error
      await expect(openDocumentFromPath("/foo/bar.pdf")).rejects.toThrow(
        "Failed to fetch document"
      );

      // Assert no overlay was appended
      // (Check that no child with the marker class was added to #viewer)
      const appendedChildren = viewerEl.appendChild.mock.calls.map((call: any) => call[0]);
      const hasMarkerClass = appendedChildren.some((child: any) =>
        child?.classList?.contains("nutrient-license-expired-overlay")
      );
      expect(hasMarkerClass).toBe(false);
    });

    it("renders overlay for expired license errors", async () => {
      // Reset and setup
      __resetForTesting();
      mockDomState.elements.clear();
      document.body.innerHTML = "<div id='viewer'></div>";

      // Setup mocks
      mockReadServerResource.mockResolvedValue({
        contents: [
          {
            uri: "nutrient-doc:///current",
            mimeType: "application/octet-stream",
            blob: "SGVsbG8=",
          },
        ],
      });

      // Make load reject with an expired license error
      mockLoad.mockRejectedValueOnce(new Error("License has expired"));

      const viewerEl = mockDomState.elements.get("viewer")!;

      // Attempt to open; this should rethrow the error
      await expect(openDocumentFromPath("/foo/bar.pdf")).rejects.toThrow(
        "License has expired"
      );

      // Assert the overlay container with marker class WAS appended
      const appendedChildren = viewerEl.appendChild.mock.calls.map((call: any) => call[0]);
      const hasMarkerClass = appendedChildren.some((child: any) =>
        child?.classList?.contains("nutrient-license-expired-overlay")
      );
      expect(hasMarkerClass).toBe(true);
    });
  });

  describe("AC1.5: Idempotence", () => {
    it("calling renderExpiredLicenseOverlay twice does not duplicate DOM nodes", () => {
      document.body.innerHTML = "<div id='viewer'></div>";
      const viewerEl = mockDomState.elements.get("viewer")!;

      // First call
      renderExpiredLicenseOverlay("https://x.com");

      // Second call with same URL
      renderExpiredLicenseOverlay("https://x.com");

      // Assert exactly one node with marker class is present
      const appendedChildren = viewerEl.appendChild.mock.calls.map((call: any) => call[0]);
      const markerClassCount = appendedChildren.filter((child: any) =>
        child?.classList?.contains("nutrient-license-expired-overlay")
      ).length;
      expect(markerClassCount).toBe(1);

      // Assert replaceChildren was called only once (on the first invocation)
      expect(viewerEl.replaceChildren).toHaveBeenCalledTimes(1);
    });
  });
});
