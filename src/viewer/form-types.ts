/**
 * Re-exports MCPFormField from src/contract/form-types.ts.
 *
 * MCPFormField lives in src/contract/ so that src/mcp/ can import
 * it without creating a cross-boundary src/mcp/ → src/viewer/ dependency.
 * This shim preserves backward compatibility for viewer-internal code that
 * previously imported from this location.
 */
export type { MCPFormField } from "../contract/form-types.js";
