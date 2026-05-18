/**
 * src/contract/ — shared type/constant layer
 *
 * This directory is the boundary between src/mcp/ (Node/server target) and
 * src/viewer/ (browser target). It contains ONLY:
 *   - Discriminated unions and interfaces that both sides need to agree on
 *   - Pure constants with no runtime deps
 *
 * MUST NOT import from node:* or from any target-specific module.
 * The ESLint no-restricted-imports rule enforces that src/mcp/** and
 * src/viewer/** do NOT cross-import each other; they both import from
 * src/contract/ only.
 */

export type { ViewerCommand } from "./viewer-commands.js";
export type {
  LicenseErrorSubKind,
  LicenseErrorPayload,
  ViewerErrorPayload
} from "./viewer-errors.js";
export {
  LICENSE_ERROR_CODE,
  LICENSE_ERROR_REQUEST_ID,
  VIEWER_ERROR_REQUEST_ID
} from "./viewer-errors.js";
export { DEFAULT_PAGE_IMAGE_WIDTH_PX } from "./constants.js";
export type {
  AnnotationType,
  AnnotationInput,
  AnnotationPatch,
  Annotation
} from "./annotation-types.js";
export type { MCPFormField } from "./form-types.js";
