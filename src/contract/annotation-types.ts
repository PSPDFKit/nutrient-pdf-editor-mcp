/**
 * Annotation types re-exported from the existing tool-side module so the
 * contract layer can reference them without duplicating definitions.
 *
 * All consumers that previously imported directly from
 * src/mcp/tools/annotation-types.ts can continue to do so; this re-export
 * is for viewers and other targets that need only the public type contract.
 *
 * MUST NOT import node:* — this file is imported by the viewer bundle
 * (browser target) as well as the server (Node target).
 */
export type {
  AnnotationType,
  AnnotationInput,
  AnnotationPatch,
  Annotation
} from "../mcp/tools/annotation-types.js";
