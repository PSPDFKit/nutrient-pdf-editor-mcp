# Changelog

All notable changes to Nutrient PDF Editor MCP are documented here.

## [1.1.6] — 2026-06-11

### Fixed
- `update_annotation` now accepts a plain string for an annotation's
  `text` (and the `contents` alias `read_annotations` returns it
  under), wrapping it into the SDK's `{ format, value }` shape exactly
  as `create_annotation` does. The two tools previously diverged: a
  plain-string `text` patch passed validation but corrupted the
  annotation record instead of updating it. The `text`/`contents`
  contract is now declared in the tool's JSON schema so malformed
  shapes fail validation up front.

### Removed
- Runtime update check and the in-viewer "update available" toast. The
  connector is now distributed through the Claude Connector directory,
  which keeps installs up to date — the server no longer polls GitHub
  for newer releases, removing its only runtime call to a non-Nutrient
  endpoint. New versions are no longer published as GitHub Releases.

## [1.1.5] — 2026-05-20

### Changed
- Viewer reflects the host app's theme on connect: the iframe's own
  overlays (loading state, unloaded-document fallback, update toast)
  render in the correct theme from first paint, and the SDK is loaded
  with the host theme explicitly instead of `AUTO`.

## [1.1.4] — 2026-05-18

### Changed
- README: documented installing the `.mcpb` by direct download.

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
