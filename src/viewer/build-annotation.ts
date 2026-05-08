/**
 * Build a Nutrient SDK annotation instance from the generic AnnotationInput.
 * Uses real SDK class constructors (never plain objects).
 * Covers all 10 annotation types with exhaustiveness checking.
 */

// Import from the contract layer — src/viewer/ must not import src/mcp/
import type { AnnotationInput } from "../contract/annotation-types.js";
import type { Annotation } from "@nutrient-sdk/viewer";

/** Type of the SDK's default export — i.e. `module.default` after
 *  `await import("@nutrient-sdk/viewer")`. Used to type the parameter
 *  passed in by the dynamic-import call site in main.ts. */
type NutrientSDKType = typeof import("@nutrient-sdk/viewer").default;
type SdkGeometry = NutrientSDKType["Geometry"];

type AnnotationInstance = Annotation;

interface RectInput {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Compute the union of one or more rects as a single bounding rectangle.
 * The `boundingBox` and the `rects` list must agree, or downstream
 * operations that consume `/Rect` (notably `applyRedactions`) silently
 * misbehave on programmatically-created annotations.
 */
function unionRects(
  rects: readonly RectInput[],
  Geometry: SdkGeometry
): InstanceType<SdkGeometry["Rect"]> {
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.left + r.width));
  const bottom = Math.max(...rects.map((r) => r.top + r.height));
  return new Geometry.Rect({
    left,
    top,
    width: right - left,
    height: bottom - top
  });
}

export function buildAnnotation(
  input: AnnotationInput,
  NutrientSDK: NutrientSDKType
): AnnotationInstance {
  const { Annotations, Geometry, Actions, Immutable, Color } = NutrientSDK;

  // Extract common fields and compute rects
  const { type, pageIndex } = input;

  switch (type) {
    case "highlight": {
      const rects = input.rects.map(
        (r) =>
          new Geometry.Rect({
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height
          })
      );
      return new Annotations.HighlightAnnotation({
        pageIndex,
        rects: Immutable.List(rects),
        boundingBox: unionRects(input.rects, Geometry)
      });
    }

    case "note": {
      const rect = new Geometry.Rect({
        left: input.rect.left,
        top: input.rect.top,
        width: input.rect.width,
        height: input.rect.height
      });
      return new Annotations.NoteAnnotation({
        pageIndex,
        boundingBox: rect,
        text: { format: "plain", value: input.text }
      });
    }

    case "text": {
      const rect = new Geometry.Rect({
        left: input.rect.left,
        top: input.rect.top,
        width: input.rect.width,
        height: input.rect.height
      });
      return new Annotations.TextAnnotation({
        pageIndex,
        boundingBox: rect,
        text: { format: "plain", value: input.text }
      });
    }

    case "ink": {
      // Convert lines: Array<Array<{x, y}>> → Immutable.List<Immutable.List<DrawingPoint>>
      const lines = input.lines.map((line) =>
        Immutable.List(
          line.map(
            (point) =>
              new Geometry.DrawingPoint({
                x: point.x,
                y: point.y,
                intensity: 1.0 // match SDK default
              })
          )
        )
      );
      return new Annotations.InkAnnotation({
        pageIndex,
        lines: Immutable.List(lines)
      });
    }

    case "strikeout": {
      const rects = input.rects.map(
        (r) =>
          new Geometry.Rect({
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height
          })
      );
      return new Annotations.StrikeOutAnnotation({
        pageIndex,
        rects: Immutable.List(rects),
        boundingBox: unionRects(input.rects, Geometry)
      });
    }

    case "underline": {
      const rects = input.rects.map(
        (r) =>
          new Geometry.Rect({
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height
          })
      );
      return new Annotations.UnderlineAnnotation({
        pageIndex,
        rects: Immutable.List(rects),
        boundingBox: unionRects(input.rects, Geometry)
      });
    }

    case "squiggly": {
      const rects = input.rects.map(
        (r) =>
          new Geometry.Rect({
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height
          })
      );
      return new Annotations.SquiggleAnnotation({
        pageIndex,
        rects: Immutable.List(rects),
        boundingBox: unionRects(input.rects, Geometry)
      });
    }

    case "link": {
      const rect = new Geometry.Rect({
        left: input.rect.left,
        top: input.rect.top,
        width: input.rect.width,
        height: input.rect.height
      });
      const action = new Actions.URIAction({
        uri: input.action.uri
      });
      return new Annotations.LinkAnnotation({
        pageIndex,
        boundingBox: rect,
        action
      });
    }

    case "widget": {
      const rect = new Geometry.Rect({
        left: input.rect.left,
        top: input.rect.top,
        width: input.rect.width,
        height: input.rect.height
      });
      return new Annotations.WidgetAnnotation({
        pageIndex,
        boundingBox: rect,
        formFieldName: input.formFieldName
      });
    }

    case "redaction": {
      const rects = input.rects.map(
        (r) =>
          new Geometry.Rect({
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height
          })
      );
      // applyRedactions consumes /Rect (the boundingBox) when computing
      // the area to burn in — not /QuadPoints. Without an explicit
      // boundingBox the SDK defaults to a zero-sized Rect serialized as
      // `/Rect [0 792 0 792]`, leaving applyRedactions a no-op for the
      // annotation: the overlay still renders in the viewer (from
      // /QuadPoints) but the underlying text is never removed.
      //
      // Visual properties (fillColor, outlineColor, overlay text) are
      // set explicitly. The constructor would apply its own defaults
      // for missing fields; pinning them here documents intent and
      // shields against any SDK quirk where the constructor path
      // diverges from InstantJSON deserialization on default merging.
      return new Annotations.RedactionAnnotation({
        pageIndex,
        rects: Immutable.List(rects),
        boundingBox: unionRects(input.rects, Geometry),
        fillColor: Color.BLACK,
        outlineColor: Color.RED,
        overlayText: null,
        repeatOverlayText: false,
        ...(input.customData && { customData: input.customData })
      });
    }

    default: {
      // Exhaustiveness check: if we reach here, type is never
      const _exhaustive: never = type;
      throw new Error(`unreachable: unknown annotation type ${_exhaustive}`);
    }
  }
}
