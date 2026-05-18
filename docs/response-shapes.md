# Response shapes

Last verified: 2026-05-04

Defines the wire shape every public tool handler must return, including the image-content exception and the Immutable.List unwrapping rule at the bridge boundary.

See also: [`error-conventions.md`](error-conventions.md), [`bridge-protocol.md`](bridge-protocol.md).

## CallToolResult shape

Every public tool handler returns:

```ts
{
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: result,
  _meta: { viewUUID }
}
```

`viewUUID` is the session's stable identifier and must appear in
`_meta` so the viewer can bind. `viewUUID` is re-emitted on every
result so the viewer can bootstrap `startPolling` on first tool
response; this is load-bearing and intentional.

**Image-content exception (`get_page_image`).** Rendered page bitmaps
are returned as an MCP `image` content block and a separate metadata
text block — never as a base64 string inside `structuredContent`.
Stuffing the data URL into `structuredContent` (the original shape)
caused hosts that text-serialize tool results to blow past per-result
token caps and dump the output to a tmp file the model cannot
reconstruct. The `image` block surfaces the PNG as multimodal input
the model actually sees:

```ts
{
  content: [
    { type: "image", data: <base64>, mimeType: "image/png" },
    { type: "text", text: <metadata markdown> }
  ],
  structuredContent: { pageWidth, pageHeight, renderedWidth, viewUUID },
  _meta: { viewUUID }
}
```

`data` is the bare base64 payload — strip the `data:image/png;base64,`
prefix the viewer hands over the bridge. No other tool currently emits
non-text content; if more are added, this is the pattern.

## Immutable.List → plain array at the boundary

The viewer converts SDK immutable collections (`getAnnotations`,
`getFormFields`, `search` results) to plain arrays before crossing the
bridge; MCP clients see JSON. `Immutable.List` is always unwrapped
with `.toArray()` before `submit_response`.

## Viewer contracts (response side)

- Never ships SDK immutable collections across the boundary —
  `Immutable.List` is always unwrapped with `.toArray()` before
  `submit_response`.
- Annotation creation uses real SDK class constructors
  (`new Annotations.*`, `new Geometry.Rect`, `Immutable.List`);
  plain objects are never passed to `instance.create/update`.
- Form fields the SDK can't serialize (unknown class) are skipped —
  never fabricated. Detection is via
  `NutrientSDK.FormFields.toSerializableObject(field)` throwing.

## Versions

`package.json#version` is the single source of truth for the
distribution version. `scripts/verify-versions.mjs` checks
`manifest.json#version` against it and fails the build on drift.
The Nutrient SDK version is pinned via
`dependencies["@nutrient-sdk/viewer"]` and inlined into
`dist/index.js` at build time via esbuild's `define` (sourced from
`node_modules/@nutrient-sdk/viewer/package.json#version`). The inlined
version is used to build the version-pinned CDN URL the iframe loads
SDK assets from. See
[`build-and-distribution.md` § "Version pinning"](build-and-distribution.md#version-pinning).
