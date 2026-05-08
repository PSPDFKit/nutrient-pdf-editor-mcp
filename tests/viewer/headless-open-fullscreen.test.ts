import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for preferFullscreenIfAvailable: one-shot bootstrap fullscreen policy.
 */

const {
  mockLoad,
  mockUnload,
  mockCallServerTool,
  mockReadServerResource,
  mockDomState,
  mockAppRef,
  mockHostContextRef,
  mockRequestDisplayMode,
  mockSendSizeChanged
} = vi.hoisted(() => {
  const mockDomState = {
    elements: new Map<string, any>()
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
    mockSendSizeChanged: vi.fn(async () => undefined)
  };
});

vi.stubGlobal("window", {
  __NUTRIENT_ASSET_BASE__: undefined,
  innerWidth: 1280,
  innerHeight: 800
});

function createMockElement(tagName: string) {
  const el: {
    tagName: string;
    className: string;
    textContent: string;
    children: unknown[];
    appendChild: (c: unknown) => unknown;
  } = {
    tagName: tagName.toUpperCase(),
    className: "",
    textContent: "",
    children: [],
    appendChild(child: unknown) {
      el.children.push(child);
      return child;
    }
  };
  return el;
}

vi.stubGlobal("document", {
  getElementById: (id: string) => mockDomState.elements.get(id) || null,
  createElement: vi.fn((tagName: string) => createMockElement(tagName)),
  createTextNode: vi.fn((text: string) => ({ nodeType: 3, textContent: text })),
  body: {
    get innerHTML() {
      return "";
    },
    set innerHTML(_html: string) {
      mockDomState.elements.clear();
      if (_html.includes("viewer") && !mockDomState.elements.has("viewer")) {
        const htmlViewerAttrs = new Map<string, string>();
        mockDomState.elements.set("viewer", {
          style: { display: "block" },
          replaceChildren: vi.fn(),
          appendChild: vi.fn(),
          setAttribute: vi.fn((key: string, value: string) => {
            htmlViewerAttrs.set(key, value);
          }),
          removeAttribute: vi.fn((key: string) => {
            htmlViewerAttrs.delete(key);
          }),
          getAttribute: vi.fn((key: string) => htmlViewerAttrs.get(key) ?? null)
        });
      }
    }
  }
});

vi.mock("@nutrient-sdk/viewer", () => ({
  default: {
    load: mockLoad,
    unload: mockUnload,
    defaultToolbarItems: []
  }
}));

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
      async connect() {}
      getHostContext() {
        return mockHostContextRef.current;
      }
      getHostVersion() {
        return { name: "test-host", version: "0.0.0" };
      }
    },
    applyDocumentTheme: () => {},
    applyHostStyleVariables: () => {},
    applyHostFonts: () => {}
  };
});

import { preferFullscreenIfAvailable, __resetForTesting } from "../../src/viewer/main";

const MOCK_INSTANCE_BASE = {
  addEventListener: () => {},
  removeEventListener: () => {},
  hasUnsavedChanges: () => false,
  exportPDF: async () => new ArrayBuffer(0)
};

beforeEach(() => {
  __resetForTesting();

  mockDomState.elements.clear();
  const viewerAttrs = new Map<string, string>();
  mockDomState.elements.set("viewer", {
    style: { display: "block" },
    replaceChildren: vi.fn(),
    appendChild: vi.fn(),
    setAttribute: vi.fn((key: string, value: string) => {
      viewerAttrs.set(key, value);
    }),
    removeAttribute: vi.fn((key: string) => {
      viewerAttrs.delete(key);
    }),
    getAttribute: vi.fn((key: string) => viewerAttrs.get(key) ?? null)
  });

  mockHostContextRef.current = undefined;

  mockLoad.mockReset();
  mockUnload.mockReset();
  mockCallServerTool.mockReset();
  mockReadServerResource.mockReset();
  mockRequestDisplayMode.mockReset();
  mockRequestDisplayMode.mockResolvedValue(undefined);
  mockSendSizeChanged.mockReset();
  mockSendSizeChanged.mockResolvedValue(undefined);

  mockLoad.mockResolvedValue({ ...MOCK_INSTANCE_BASE, id: "mock-instance" });

  mockReadServerResource.mockResolvedValue({
    contents: [
      {
        uri: "nutrient-doc:///current",
        mimeType: "application/octet-stream",
        blob: "SGVsbG8="
      }
    ]
  });

  mockCallServerTool.mockResolvedValue({ structuredContent: {} });
});

describe("preferFullscreenIfAvailable", () => {
  // One-shot bootstrap policy: when the host advertises fullscreen, ask
  // for it. Otherwise leave the host's pick alone. Documented in
  // src/viewer/main.ts above the helper.

  it("requests fullscreen when the host advertises it and currently has us in inline", async () => {
    mockHostContextRef.current = {
      availableDisplayModes: ["inline", "fullscreen"],
      displayMode: "inline"
    };

    await preferFullscreenIfAvailable();

    expect(mockRequestDisplayMode).toHaveBeenCalledTimes(1);
    expect(mockRequestDisplayMode).toHaveBeenCalledWith({ mode: "fullscreen" });
  });

  it("does not request a mode when fullscreen is not advertised (inline-only host)", async () => {
    mockHostContextRef.current = {
      availableDisplayModes: ["inline"],
      displayMode: "inline"
    };

    await preferFullscreenIfAvailable();

    expect(mockRequestDisplayMode).not.toHaveBeenCalled();
  });

  it("does not request a mode when the host has already picked fullscreen", async () => {
    mockHostContextRef.current = {
      availableDisplayModes: ["inline", "fullscreen"],
      displayMode: "fullscreen"
    };

    await preferFullscreenIfAvailable();

    expect(mockRequestDisplayMode).not.toHaveBeenCalled();
  });

  it("only ever requests once per session even if called repeatedly", async () => {
    mockHostContextRef.current = {
      availableDisplayModes: ["inline", "fullscreen"],
      displayMode: "inline"
    };

    await preferFullscreenIfAvailable();
    await preferFullscreenIfAvailable();
    await preferFullscreenIfAvailable();

    expect(mockRequestDisplayMode).toHaveBeenCalledTimes(1);
  });

  it("swallows requestDisplayMode rejection so a host refusal doesn't crash the bootstrap", async () => {
    mockHostContextRef.current = {
      availableDisplayModes: ["inline", "fullscreen"],
      displayMode: "inline"
    };
    mockRequestDisplayMode.mockRejectedValueOnce(new Error("host rejected"));

    await expect(preferFullscreenIfAvailable()).resolves.toBeUndefined();
    expect(mockRequestDisplayMode).toHaveBeenCalledTimes(1);
  });
});
