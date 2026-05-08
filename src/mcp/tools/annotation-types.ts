import { z } from "zod";

/**
 * All annotation types supported by the generic CRUD tools.
 */
export type AnnotationType =
  | "highlight"
  | "note"
  | "text"
  | "ink"
  | "strikeout"
  | "underline"
  | "squiggly"
  | "link"
  | "widget"
  | "redaction";

/**
 * Rectangle shape: left, top, width, height in points.
 */
const rectSchema = z.object({
  left: z.number().describe("Left coordinate in points"),
  top: z.number().describe("Top coordinate in points"),
  width: z.number().describe("Width in points"),
  height: z.number().describe("Height in points")
});

/**
 * Point in a line: x, y coordinates.
 */
const pointSchema = z.object({
  x: z.number().describe("X coordinate"),
  y: z.number().describe("Y coordinate")
});

/**
 * Discriminated union of annotation inputs.
 * Each variant is keyed by the 'type' discriminant and includes type-specific required fields.
 */
export const AnnotationInput = z.discriminatedUnion("type", [
  // Highlight: requires rects for text selection
  z.object({
    type: z.literal("highlight"),
    pageIndex: z.number().int().nonnegative(),
    rects: z.array(rectSchema).nonempty().describe("One or more selection rectangles")
  }),

  // Note: requires rect and text
  z.object({
    type: z.literal("note"),
    pageIndex: z.number().int().nonnegative(),
    rect: rectSchema.describe("Bounding box for the note"),
    text: z.string().describe("Note content")
  }),

  // Text: free-text annotation with rect and text
  z.object({
    type: z.literal("text"),
    pageIndex: z.number().int().nonnegative(),
    rect: rectSchema.describe("Bounding box for the text"),
    text: z.string().describe("Free-text content")
  }),

  // Ink: drawing with line segments
  z.object({
    type: z.literal("ink"),
    pageIndex: z.number().int().nonnegative(),
    lines: z
      .array(z.array(pointSchema))
      .nonempty()
      .describe("Array of line segments, each a list of points")
  }),

  // Strikeout: text markup with rects
  z.object({
    type: z.literal("strikeout"),
    pageIndex: z.number().int().nonnegative(),
    rects: z.array(rectSchema).nonempty().describe("One or more selection rectangles")
  }),

  // Underline: text markup with rects
  z.object({
    type: z.literal("underline"),
    pageIndex: z.number().int().nonnegative(),
    rects: z.array(rectSchema).nonempty().describe("One or more selection rectangles")
  }),

  // Squiggly: text markup with rects
  z.object({
    type: z.literal("squiggly"),
    pageIndex: z.number().int().nonnegative(),
    rects: z.array(rectSchema).nonempty().describe("One or more selection rectangles")
  }),

  // Link: action-based annotation
  z.object({
    type: z.literal("link"),
    pageIndex: z.number().int().nonnegative(),
    rect: rectSchema.describe("Bounding box for the link"),
    action: z.object({
      uri: z.string().describe("URI for the link action")
    })
  }),

  // Widget: form field reference
  z.object({
    type: z.literal("widget"),
    pageIndex: z.number().int().nonnegative(),
    rect: rectSchema.describe("Bounding box for the widget"),
    formFieldName: z.string().describe("Name of the associated form field")
  }),

  // Redaction: requires rects for areas to redact
  z.object({
    type: z.literal("redaction"),
    pageIndex: z.number().int().nonnegative(),
    rects: z.array(rectSchema).nonempty().describe("One or more redaction rectangles"),
    customData: z.object({}).passthrough().optional().describe("Optional custom metadata")
  })
]);

export type AnnotationInput = z.infer<typeof AnnotationInput>;

/**
 * Loose schema for annotation patches (updates).
 * SDK handles type coercion, so we accept any field.
 */
export const AnnotationPatch = z.object({}).passthrough();

export type AnnotationPatch = z.infer<typeof AnnotationPatch>;

/**
 * Normalized return shape for annotations from read operations.
 */
export interface Annotation {
  id: string;
  type: AnnotationType;
  pageIndex: number;
  rect: { left: number; top: number; width: number; height: number };
  contents?: string;
  customData?: Record<string, unknown>;
}
