import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for negotiateFrameSize: size-hint emission, inline-mode height cap,
 * window-dimension fallback, host-context-changed re-fire, and dedup guard.
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

import { negotiateFrameSize, __resetForTesting } from "../../src/viewer/main";

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

describe("negotiateFrameSize", () => {
  // `negotiateFrameSize` itself is a pure size-hint emitter. The fullscreen
  // preference is a separate one-shot call (`preferFullscreenIfAvailable`)
  // that runs once at bootstrap, not on every host-context-changed. These
  // tests pin that separation so a future change can't accidentally fold a
  // mode-request into the size-hint loop and ping-pong with the host.

  it("never calls requestDisplayMode even when the host advertises a non-current mode", async () => {
    mockHostContextRef.current = {
      availableDisplayModes: ["fullscreen", "inline"],
      displayMode: "inline",
      containerDimensions: { width: 1280, height: 800 }
    };

    await negotiateFrameSize();

    expect(mockRequestDisplayMode).not.toHaveBeenCalled();
    expect(mockSendSizeChanged).toHaveBeenCalledTimes(1);
    expect(mockSendSizeChanged).toHaveBeenCalledWith({ width: 1280, height: 800 });
  });

  it("emits one size hint when the host already picked fullscreen, no requestDisplayMode", async () => {
    mockHostContextRef.current = {
      availableDisplayModes: ["fullscreen", "inline"],
      displayMode: "fullscreen",
      containerDimensions: { width: 1024, height: 768 }
    };

    await negotiateFrameSize();

    expect(mockRequestDisplayMode).not.toHaveBeenCalled();
    expect(mockSendSizeChanged).toHaveBeenCalledWith({ width: 1024, height: 768 });
  });

  it("caps inline-mode height when host advertises only maxHeight (post-fullscreen-X scenario)", async () => {
    mockHostContextRef.current = {
      availableDisplayModes: ["inline"],
      displayMode: "inline",
      containerDimensions: { maxWidth: 800, maxHeight: 4000 }
    };

    await negotiateFrameSize();

    expect(mockRequestDisplayMode).not.toHaveBeenCalled();
    expect(mockSendSizeChanged).toHaveBeenCalledWith({ width: 800, height: 600 });
  });

  it("falls back to window dimensions when no host dimensions are advertised", async () => {
    mockHostContextRef.current = {
      availableDisplayModes: [],
      displayMode: undefined
    };

    await negotiateFrameSize();

    expect(mockRequestDisplayMode).not.toHaveBeenCalled();
    expect(mockSendSizeChanged).toHaveBeenCalledWith({ width: 1280, height: 800 });
  });

  it("re-fires size negotiation on host-context-changed (e.g. Cowork returning to foreground)", async () => {
    mockHostContextRef.current = {
      availableDisplayModes: [],
      containerDimensions: { width: 0, height: 0 }
    };
    await negotiateFrameSize();
    const initialSizeCalls = mockSendSizeChanged.mock.calls.length;

    mockHostContextRef.current = {
      availableDisplayModes: ["fullscreen"],
      displayMode: "fullscreen",
      containerDimensions: { width: 1440, height: 900 }
    };
    mockAppRef.current!.onhostcontextchanged?.(mockHostContextRef.current);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSendSizeChanged.mock.calls.length).toBeGreaterThan(initialSizeCalls);
    expect(mockSendSizeChanged).toHaveBeenLastCalledWith({
      width: 1440,
      height: 900
    });
    expect(mockRequestDisplayMode).not.toHaveBeenCalled();
  });

  it("never calls requestDisplayMode across multiple host-context-changed events", async () => {
    mockHostContextRef.current = {
      availableDisplayModes: ["fullscreen", "inline"],
      displayMode: "inline",
      containerDimensions: { width: 1280, height: 800 }
    };
    await negotiateFrameSize();
    expect(mockRequestDisplayMode).not.toHaveBeenCalled();

    mockHostContextRef.current = {
      availableDisplayModes: ["fullscreen", "inline"],
      displayMode: "fullscreen",
      containerDimensions: { width: 1280, height: 800 }
    };
    mockAppRef.current!.onhostcontextchanged?.(mockHostContextRef.current);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    mockHostContextRef.current = {
      availableDisplayModes: ["fullscreen", "inline"],
      displayMode: "inline",
      containerDimensions: { width: 1280, height: 800 }
    };
    mockAppRef.current!.onhostcontextchanged?.(mockHostContextRef.current);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockRequestDisplayMode).not.toHaveBeenCalled();
  });

  it("dedupes sendSizeChanged when target dims are unchanged (loop guard)", async () => {
    mockHostContextRef.current = {
      availableDisplayModes: ["fullscreen"],
      displayMode: "fullscreen",
      containerDimensions: { width: 1280, height: 800 }
    };
    await negotiateFrameSize();
    expect(mockSendSizeChanged).toHaveBeenCalledTimes(1);

    mockAppRef.current!.onhostcontextchanged?.(mockHostContextRef.current);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSendSizeChanged).toHaveBeenCalledTimes(1);

    mockHostContextRef.current = {
      ...mockHostContextRef.current,
      containerDimensions: { width: 1600, height: 900 }
    };
    mockAppRef.current!.onhostcontextchanged?.(mockHostContextRef.current);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSendSizeChanged).toHaveBeenCalledTimes(2);
    expect(mockSendSizeChanged).toHaveBeenLastCalledWith({
      width: 1600,
      height: 900
    });
  });
});
