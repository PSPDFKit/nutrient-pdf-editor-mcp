# src/viewer — Browser Bundle

Last verified: 2026-05-01

## Purpose

Browser bundle that runs inside the Cowork iframe, bridges the MCP
command queue to the real Nutrient Web Viewer, and translates SDK return
shapes into the plain JSON contracts that MCP clients see. Inlined by
Vite so the iframe can load it under a strict CSP.

This file is agent-facing. The contract / decision / invariant prose
that used to live here moved to `docs/`; the links below are the
canonical homes.

## Where things live

- [`docs/auto-save.md`](../../docs/auto-save.md) — viewer auto-save
  loop, `flushIfDirty` vs `flushNow`, terminal-flush list.
- [`docs/response-shapes.md`](../../docs/response-shapes.md) —
  `CallToolResult` shape, image-content exception.
- [`docs/bridge-protocol.md`](../../docs/bridge-protocol.md) — wire
  protocol the viewer speaks to the server.
- [`docs/document-lifecycle.md`](../../docs/document-lifecycle.md)
  — full open / close / in-place-switch state machine,
  iframe-side atomic-SDK-swap design rationale, CSS-only placeholder
  semantics.

## Boundaries

- Must NOT import `node:*` — TS config disables `types: ["node"]`
  for this target. The only allowed import from `src/mcp/` is
  *types* (e.g., `AnnotationInput` from
  `../mcp/tools/annotation-types.js`).
- Annotation creation must use real SDK class constructors
  (`new Annotations.*`, `new Geometry.Rect`, `Immutable.List`); plain
  objects are never passed to `instance.create/update`.
- Form fields the SDK can't serialize via
  `NutrientSDK.FormFields.toSerializableObject(field)` are dropped —
  never fabricated.
- All SDK `.getAnnotations(p)`, `.getFormFields()`, `.search(...)`
  results pass through `.toArray()` before crossing the bridge.
- `submit()` is called exactly once per `requestId` — either with
  data or with an error.

## Gotchas

- The viewer's `startPolling` must be called exactly once per session.
  `ontoolresult` fires on every tool result; re-entry was a real
  regression (issue I3) and is now guarded by a `pollingStarted` flag
  in `main.ts`. Do not remove that guard.
- `removePages` does not exist on the SDK. Use `keepPages` with the
  inverse page set.
- `getFormFieldValues()` is **synchronous** — do NOT `await` it.
  Awaiting returns a Promise and the map lookup then returns
  `undefined` for every field.
- Page rendering: use
  `renderPageAsArrayBuffer({ width }, pageIndex) → Promise<ArrayBuffer>`
  which returns **raw RGBA pixels** (not PNG bytes), **not**
  `renderPageAsImageURL` — the latter returns a `blob:` URL we'd have
  to `fetch()` back, and the Cowork iframe's CSP `connect-src` only
  allows the configured Nutrient origins, so blob: fetches fail with
  "Failed to fetch". Both APIs share the positional
  `({width|height}, pageIndex)` signature; the keyed-vs-positional
  gotcha applies to either.

  The full `get_page_image` pipeline is:
  1. `renderPageAsArrayBuffer({ width }, pageIndex)` → `ArrayBuffer`
     (raw RGBA pixels, `width × height × 4` bytes).
  2. Wrap in a `Canvas` element via `OffscreenCanvas` or `document.createElement("canvas")`;
     set `canvas.width = width`, `canvas.height = height`.
  3. `ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0)`.
  4. `canvas.toDataURL("image/png")` → `data:image/png;base64,<...>`.
  5. Strip the `data:image/png;base64,` prefix; send the bare base64
     payload across the bridge as `submit(requestId, { data: base64, width, height })`.
  6. Server strips prefix (already done in step 5), wraps in an MCP
     `image` content block `{ type: "image", data: base64, mimeType: "image/png" }`,
     and returns `{ pageWidth, pageHeight, renderedWidth }` as the
     accompanying metadata text block and in `structuredContent`.

  The encoding step (steps 2–4) runs on the main thread in the iframe;
  it is synchronous and can block UI for 80–200 ms on large pages.
  See the Batch D action-plan item for a Web Worker offload if that
  latency becomes a problem.
- `textLinesForPageIndex()` is the correct page-text API;
  `textForPageIndex()` does not exist.
- Checkbox updates take an `Immutable.List<string>` of option values
  to check (often `List(["Yes"])`, but the on-value is whatever the
  field's `options[].value` declares — never assume `"Yes"`). Empty
  `List()` clears. The `update_form_field_values` MCP tool accepts a
  bare string for ergonomic LLM input and wraps it via
  `Immutable.List([value])` automatically.
- `apply_redactions_now` mutates the document in place; callers must
  have already passed the elicitation gate in the server tool.
- Error messages carried via `submit(id, null, "...")` surface to the
  MCP client as `McpError(InvalidParams, ...)`. Keep them
  user-readable; they are shown in Cowork verbatim.
- Unknown SDK form field classes throw inside
  `NutrientSDK.FormFields.toSerializableObject(field)` and the field
  is dropped from the read output. Adding a new supported type means:
  (a) the SDK already serializes it via `Serializers.FormFieldJSON`,
  and (b) the lenient validator in `form-operations.ts`
  (`normalizeValue` / `validateFormFieldValue`) covers its
  `instanceof` branch.
- **Never use `constructor.name` against SDK classes.** The Nutrient
  SDK's UMD bundle ships with already-minified internal class names
  (e.g., `HighlightAnnotation` is `y.ax` at runtime). Use
  `instanceof NutrientSDK.Annotations.X` or
  `instanceof NutrientSDK.FormFields.X` for type discrimination.
  `sdkClassToType` (main.ts) takes the SDK handle as a second
  argument for this reason; the form-field path now relies on the
  SDK's own `FormFields.toSerializableObject` (line
  `dist/index.d.ts:11315`) which uses the same `instanceof`
  discrimination internally.
- **Inline-mode height cap.** `negotiateFrameSize` honors any fixed
  `containerDimensions.height` from the host. When the host
  advertises only `maxHeight` AND `displayMode === "inline"` (the
  Cowork conversation pane), the height is capped at
  `INLINE_HEIGHT_PX = 600` so the iframe doesn't fill the entire
  scroll extent after the user exits fullscreen. Fullscreen /
  non-inline modes fall back to `maxHeight ?? window.innerHeight`
  unchanged.
- **`boundingBox` on freshly-created markup annotations is a
  zero-sized `Rect`, not `null`.** `extractRect` in main.ts falls
  back to the union of `a.rects` (markup) or `a.rect` (note/text)
  when the bounding box width/height are both zero. Unit tests that
  construct SDK annotations in-memory must either set a non-zero
  `boundingBox` or provide valid `rects`.
- **Redaction annotations MUST be constructed with an explicit
  `boundingBox`.** `applyRedactions` consumes `/Rect` (the boundingBox)
  to compute what to burn in — not `/QuadPoints`. A redaction created
  with only `rects` serializes as `/Rect [0 792 0 792]` (the SDK's
  zero-sized default) and apply silently no-ops on it: the overlay
  renders correctly, but the underlying text is never removed. See
  `build-annotation.ts` `case "redaction"` — it sets `boundingBox` to
  `union(rects)`, mirroring what the SDK's UI redaction tools do.
