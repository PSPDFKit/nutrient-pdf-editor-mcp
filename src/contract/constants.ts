/**
 * Cross-cutting constants shared between the MCP server (Node target) and
 * the viewer iframe (browser target).
 *
 * MUST NOT import node:* — this file is imported by both targets.
 *
 * DEFAULT_PAGE_IMAGE_WIDTH_PX is named consistently on both sides with this
 * single definition. Cross-reference:
 *   - Server consumer: src/mcp/tools/get-page-image.ts (default for width param)
 *   - Viewer consumer: src/viewer/main.ts getPageImage handler (width ?? DEFAULT)
 */

/**
 * Default rendered page width in pixels for get_page_image when the caller
 * does not specify a width. 1200px provides good detail for most documents
 * at a file size the MCP context window can accommodate comfortably.
 *
 * Cross-reference: src/mcp/tools/get-page-image.ts + src/viewer/main.ts
 * (both must agree — they speak through the bridge, not direct calls).
 */
export const DEFAULT_PAGE_IMAGE_WIDTH_PX = 1200;
