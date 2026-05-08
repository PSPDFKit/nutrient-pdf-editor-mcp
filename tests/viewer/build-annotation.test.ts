import { describe, it, expect } from "vitest";
import { buildAnnotation } from "../../src/viewer/build-annotation.js";
import { sdkClassToType } from "../../src/viewer/main.js";
import type { AnnotationInput } from "../../src/contract/annotation-types.js";

// The two helpers below are the *only* type-level adapters between this
// test file and the SDK-typed call signatures. Tests pass a hand-rolled
// `fakeSDK` (a tiny subset of the 100+ exports on `typeof NutrientViewer`)
// and read back fake-class instances whose properties don't appear on the
// real `Annotation` union. The structural mismatch is intentional — we
// cast once at the boundary rather than littering call sites with `as any`.
type SDKArg = Parameters<typeof buildAnnotation>[1];

interface FakeImmutableList<T = unknown> {
  __immutableList: boolean;
  _items: T[];
}
interface FakeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface FakeDrawingPoint {
  x: number;
  y: number;
  intensity: number;
}

interface FakeAnnotationResult {
  _class: string;
  pageIndex?: number;
  boundingBox?: FakeRect;
  rects?: FakeImmutableList;
  lines?: FakeImmutableList<FakeImmutableList<FakeDrawingPoint>>;
  text?: { format: string; value: string };
  formFieldName?: string;
  fillColor?: { _color: string };
  outlineColor?: { _color: string };
  overlayText?: string | null;
  repeatOverlayText?: boolean;
  action?: { uri: string };
}

const buildFakeAnnotation = (
  input: AnnotationInput,
  sdk: unknown
): FakeAnnotationResult =>
  buildAnnotation(input, sdk as SDKArg) as unknown as FakeAnnotationResult;

const sdkClassToTypeFake = (annotation: unknown, sdk: unknown): string =>
  sdkClassToType(annotation, sdk as SDKArg);

describe("buildAnnotation and sdkClassToType", () => {
  /**
   * Stub SDK with all required classes and methods.
   * Class instances track their _class name for instanceof-like checks.
   */
  const createFakeSDK = () => {
    // Base constructor helper
    const makeAnnotationClass = (className: string) => {
      class FakeAnnotation {
        _class = className;
        [key: string]: any;

        constructor(params: any) {
          Object.assign(this, params);
        }
      }
      Object.defineProperty(FakeAnnotation, "name", { value: className });
      return FakeAnnotation;
    };

    return {
      Annotations: {
        HighlightAnnotation: makeAnnotationClass("HighlightAnnotation"),
        NoteAnnotation: makeAnnotationClass("NoteAnnotation"),
        TextAnnotation: makeAnnotationClass("TextAnnotation"),
        InkAnnotation: makeAnnotationClass("InkAnnotation"),
        StrikeOutAnnotation: makeAnnotationClass("StrikeOutAnnotation"),
        UnderlineAnnotation: makeAnnotationClass("UnderlineAnnotation"),
        SquiggleAnnotation: makeAnnotationClass("SquiggleAnnotation"),
        LinkAnnotation: makeAnnotationClass("LinkAnnotation"),
        WidgetAnnotation: makeAnnotationClass("WidgetAnnotation"),
        RedactionAnnotation: makeAnnotationClass("RedactionAnnotation")
      },
      Geometry: {
        Rect: class FakeRect {
          left: number;
          top: number;
          width: number;
          height: number;

          constructor(obj: any) {
            this.left = obj.left;
            this.top = obj.top;
            this.width = obj.width;
            this.height = obj.height;
          }
        },
        DrawingPoint: class FakeDrawingPoint {
          x: number;
          y: number;
          intensity: number;

          constructor(obj: any) {
            this.x = obj.x;
            this.y = obj.y;
            this.intensity = obj.intensity ?? 1.0;
          }
        }
      },
      Actions: {
        URIAction: class FakeURIAction {
          uri: string;

          constructor(obj: any) {
            this.uri = obj.uri;
          }
        }
      },
      Immutable: {
        List: (items: any) => ({
          __immutableList: true,
          _items: Array.isArray(items) ? items : Array.from(items || [])
        })
      },
      Color: {
        BLACK: { _color: "BLACK" },
        RED: { _color: "RED" }
      }
    };
  };

  describe("buildAnnotation with all 10 types", () => {
    it("builds highlight annotation", () => {
      const fakeSDK = createFakeSDK();
      const input = {
        type: "highlight" as const,
        pageIndex: 0,
        rects: [{ left: 10, top: 20, width: 100, height: 15 }]
      };

      const result = buildFakeAnnotation(input, fakeSDK);

      expect(result._class).toBe("HighlightAnnotation");
      expect(result.pageIndex).toBe(0);
      expect(result.rects).toBeTruthy();
      expect((result.rects as any).__immutableList).toBe(true);
      expect((result.rects as any)._items.length).toBe(1);
      // boundingBox = union(rects); single rect ⇒ identical bounds.
      expect(result.boundingBox).toEqual(
        expect.objectContaining({ left: 10, top: 20, width: 100, height: 15 })
      );
    });

    it.each([
      ["strikeout", "StrikeOutAnnotation"],
      ["underline", "UnderlineAnnotation"],
      ["squiggly", "SquiggleAnnotation"]
    ] as const)(
      "builds %s annotation with boundingBox = union(rects)",
      (type, className) => {
        const fakeSDK = createFakeSDK();
        const input = {
          type,
          pageIndex: 0,
          rects: [
            { left: 10, top: 20, width: 30, height: 12 }, // 10..40, 20..32
            { left: 50, top: 18, width: 20, height: 14 }  // 50..70, 18..32
          ]
        };

        const result = buildFakeAnnotation(input, fakeSDK);

        expect(result._class).toBe(className);
        // Union: left=10, top=18, right=70, bottom=32 ⇒ width=60, height=14
        expect(result.boundingBox).toEqual(
          expect.objectContaining({ left: 10, top: 18, width: 60, height: 14 })
        );
      }
    );

    it("builds note annotation", () => {
      const fakeSDK = createFakeSDK();
      const input = {
        type: "note" as const,
        pageIndex: 0,
        rect: { left: 10, top: 20, width: 100, height: 15 },
        text: "note content"
      };

      const result = buildFakeAnnotation(input, fakeSDK);

      expect(result._class).toBe("NoteAnnotation");
      expect(result.pageIndex).toBe(0);
      expect(result.boundingBox).toBeTruthy();
      expect(result.text).toEqual({ format: "plain", value: "note content" });
    });

    it("builds text annotation", () => {
      const fakeSDK = createFakeSDK();
      const input = {
        type: "text" as const,
        pageIndex: 1,
        rect: { left: 20, top: 30, width: 150, height: 20 },
        text: "free text"
      };

      const result = buildFakeAnnotation(input, fakeSDK);

      expect(result._class).toBe("TextAnnotation");
      expect(result.pageIndex).toBe(1);
      expect(result.text).toEqual({ format: "plain", value: "free text" });
    });

    it("builds ink annotation with DrawingPoints", () => {
      const fakeSDK = createFakeSDK();
      const input = {
        type: "ink" as const,
        pageIndex: 0,
        lines: [
          [{ x: 10, y: 20 }, { x: 30, y: 40 }],
          [{ x: 50, y: 60 }, { x: 70, y: 80 }]
        ]
      };

      const result = buildFakeAnnotation(input, fakeSDK);

      expect(result._class).toBe("InkAnnotation");
      expect(result.pageIndex).toBe(0);
      expect((result.lines as any).__immutableList).toBe(true);
      const lines = (result.lines as any)._items;
      expect(lines.length).toBe(2);
      expect((lines[0] as any).__immutableList).toBe(true);
      expect((lines[0] as any)._items.length).toBe(2);
      expect((lines[0] as any)._items[0].x).toBe(10);
      expect((lines[0] as any)._items[0].intensity).toBe(1.0); // Should default to 1.0
    });

    it("builds strikeout annotation", () => {
      const fakeSDK = createFakeSDK();
      const input = {
        type: "strikeout" as const,
        pageIndex: 0,
        rects: [{ left: 10, top: 20, width: 100, height: 15 }]
      };

      const result = buildFakeAnnotation(input, fakeSDK);

      expect(result._class).toBe("StrikeOutAnnotation");
      expect((result.rects as any).__immutableList).toBe(true);
    });

    it("builds underline annotation", () => {
      const fakeSDK = createFakeSDK();
      const input = {
        type: "underline" as const,
        pageIndex: 0,
        rects: [{ left: 10, top: 20, width: 100, height: 15 }]
      };

      const result = buildFakeAnnotation(input, fakeSDK);

      expect(result._class).toBe("UnderlineAnnotation");
      expect((result.rects as any).__immutableList).toBe(true);
    });

    it("builds squiggly annotation", () => {
      const fakeSDK = createFakeSDK();
      const input = {
        type: "squiggly" as const,
        pageIndex: 0,
        rects: [{ left: 10, top: 20, width: 100, height: 15 }]
      };

      const result = buildFakeAnnotation(input, fakeSDK);

      expect(result._class).toBe("SquiggleAnnotation");
      expect((result.rects as any).__immutableList).toBe(true);
    });

    it("builds link annotation with URIAction", () => {
      const fakeSDK = createFakeSDK();
      const input = {
        type: "link" as const,
        pageIndex: 0,
        rect: { left: 10, top: 20, width: 100, height: 15 },
        action: { uri: "https://example.com" }
      };

      const result = buildFakeAnnotation(input, fakeSDK);

      expect(result._class).toBe("LinkAnnotation");
      expect(result.boundingBox).toBeTruthy();
      expect(result.action?.uri).toBe("https://example.com");
    });

    it("builds widget annotation", () => {
      const fakeSDK = createFakeSDK();
      const input = {
        type: "widget" as const,
        pageIndex: 0,
        rect: { left: 10, top: 20, width: 100, height: 15 },
        formFieldName: "field_name"
      };

      const result = buildFakeAnnotation(input, fakeSDK);

      expect(result._class).toBe("WidgetAnnotation");
      expect(result.formFieldName).toBe("field_name");
    });

    it("builds redaction annotation with boundingBox matching the single rect", () => {
      const fakeSDK = createFakeSDK();
      const input = {
        type: "redaction" as const,
        pageIndex: 0,
        rects: [{ left: 10, top: 20, width: 100, height: 15 }]
      };

      const result = buildFakeAnnotation(input, fakeSDK);

      expect(result._class).toBe("RedactionAnnotation");
      expect((result.rects as any).__immutableList).toBe(true);
      // boundingBox is required so applyRedactions has a non-zero /Rect to
      // burn in; without it the SDK defaults to a zero-sized Rect that
      // serializes as `/Rect [0 792 0 792]` and apply silently no-ops.
      expect(result.boundingBox).toEqual(
        expect.objectContaining({ left: 10, top: 20, width: 100, height: 15 })
      );
      // Visual properties pinned explicitly.
      expect(result.fillColor).toEqual({ _color: "BLACK" });
      expect(result.outlineColor).toEqual({ _color: "RED" });
      expect(result.overlayText).toBeNull();
      expect(result.repeatOverlayText).toBe(false);
    });

    it("builds redaction annotation with boundingBox = union of multiple rects", () => {
      const fakeSDK = createFakeSDK();
      const input = {
        type: "redaction" as const,
        pageIndex: 0,
        rects: [
          { left: 10, top: 20, width: 30, height: 12 },   // 10..40, 20..32
          { left: 50, top: 18, width: 20, height: 14 },   // 50..70, 18..32
          { left: 5, top: 25, width: 8, height: 10 }      // 5..13, 25..35
        ]
      };

      const result = buildFakeAnnotation(input, fakeSDK);

      // Union: left=5, top=18, right=70, bottom=35 → width=65, height=17
      expect(result.boundingBox).toEqual(
        expect.objectContaining({ left: 5, top: 18, width: 65, height: 17 })
      );
    });
  });

  describe("sdkClassToType mapping", () => {
    const fakeSDK = createFakeSDK();

    const testCases = [
      { className: "HighlightAnnotation", type: "highlight" },
      { className: "NoteAnnotation", type: "note" },
      { className: "TextAnnotation", type: "text" },
      { className: "InkAnnotation", type: "ink" },
      { className: "StrikeOutAnnotation", type: "strikeout" },
      { className: "UnderlineAnnotation", type: "underline" },
      { className: "SquiggleAnnotation", type: "squiggly" },
      { className: "LinkAnnotation", type: "link" },
      { className: "WidgetAnnotation", type: "widget" },
      { className: "RedactionAnnotation", type: "redaction" }
    ];

    for (const { className, type } of testCases) {
      it(`maps ${className} to "${type}"`, () => {
        const fakeAnnotation = new (fakeSDK.Annotations as any)[className]({});
        const result = sdkClassToTypeFake(fakeAnnotation, fakeSDK);
        expect(result).toBe(type);
      });
    }

    it("returns 'unknown' for unrecognized class", () => {
      class StrangerAnnotation {}
      const fakeAnnotation = new StrangerAnnotation();
      const result = sdkClassToTypeFake(fakeAnnotation, fakeSDK);
      expect(result).toBe("unknown");
    });

    it("returns 'unknown' when annotation is null", () => {
      expect(sdkClassToTypeFake(null, fakeSDK)).toBe("unknown");
    });

    it("returns 'unknown' when SDK has no Annotations namespace", () => {
      const fakeAnnotation = new (fakeSDK.Annotations as any).HighlightAnnotation({});
      expect(sdkClassToTypeFake(fakeAnnotation, {})).toBe("unknown");
    });
  });

  describe("exhaustiveness check", () => {
    it("throws on invalid type", () => {
      const fakeSDK = createFakeSDK();
      const input = { type: "bogus", pageIndex: 0 } as any;

      expect(() => buildFakeAnnotation(input, fakeSDK)).toThrow(/unreachable|unknown annotation type/i);
    });
  });
});
