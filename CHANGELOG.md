# Changelog

All notable changes to Nutrient PDF Editor MCP are documented here.

## [1.1.3] — 2026-05-18

### Fixed
- Test suite: eliminated 5 s timeouts in large-binary-data tests by replacing
  slow `Uint8Array.from(atob(…), mapper)` and one-char-at-a-time
  `String.fromCharCode` loops with efficient chunked equivalents.

## [1.1.2] — 2026-05-18

### Changed
- Build script cleanups.

## [1.1.1] — 2026-05-18

### Added
- Runtime update check: on startup the server compares its version against the latest GitHub release and, when a newer one exists, shows a dismissible notice in the viewer prompting the user to download the latest build from nutrient.io/claude-desktop.

## [1.1.0] — 2026-05-18

### Changed
- Bumped Nutrient Web SDK (`@nutrient-sdk/viewer`) from 1.14.x to **1.15.0**.

## [1.0.0] — 2026-05-08

Initial public release.

### Added
- 16 public PDF-editor tools: `open_document`, `close_document`, `get_view_state`, `set_view_state`, `search_exact_text`, `read_document_information`, `read_page_info`, `get_page_image`, `read_text`, `create_annotation`, `read_annotations`, `update_annotation`, `delete_annotation`, `apply_annotations`, `read_form_fields`, `update_form_field_values`.
- Embedded Nutrient Web Viewer rendered inside Claude Cowork via MCP Apps (`text/html;profile=mcp-app`).
- MCPB packaging for Claude Desktop / Claude Cowork installation.
- Shared-state staging directory with atomic write-back to the source file.
- License expiry surfaced to the model with a renewal prompt.
- Capability gate: rejects `initialize` when the client does not advertise the `extensions.io.modelcontextprotocol/ui` capability.
