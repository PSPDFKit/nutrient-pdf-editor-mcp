# Manual QA

Last verified: 2026-05-08

End-to-end smoke test for the installed Connector running inside Claude
Cowork. Drives every public tool from a single chat prompt against
known-good fixtures so a failing build, an unrenewed license, or a
regressed tool surface is obvious in one pass.

## Setup

1. Build and install the `.mcpb` (see
   [`build-and-distribution.md`](build-and-distribution.md)). The
   embedded viewer fetches its runtime from the public Nutrient CDN on
   first launch — confirm network is available.
2. Open a Cowork chat in Claude Desktop and **attach this repo's
   `tests/fixtures/` directory as the project root** (Claude Desktop →
   project settings → "Files & folders"). The path-guard in
   `src/mcp/path-guard.ts` rejects any tool path that doesn't fall
   under an MCP-advertised root, and Cowork advertises the attached
   project folder via `roots/list` at `initialize`. If the QA prompt
   returns "MCP client has not advertised any filesystem roots" on the
   first `open_document`, the project root is unset.
3. Confirm `tests/fixtures/sample.pdf` and
   `tests/fixtures/form_example.pdf` exist — they are the two fixtures
   the prompt references by bare filename.

## Prompt

Paste the block below verbatim into the Cowork chat. The model walks the
28 steps in order and prints a summary table at the end.

> You are testing the Nutrient PDF Editor MCP connector. Exercise every
> public tool below in order. After each call, briefly state PASS or
> FAIL plus what you observed (1 line). At the end, give a summary
> table. Use these two fixture files (both already in the repo's
> path-guard roots):
>
> - TEXT_PDF: `sample.pdf`
> - FORM_PDF: `form_example.pdf`
>
> If a tool returns an `McpError`, record the `ErrorCode` and message
> and continue with the next test — do not abort the run.
>
> ═══════════════════════════════════════════════════════════
> PHASE 1 — Open + read-only tools (TEXT_PDF)
> ═══════════════════════════════════════════════════════════
>
> 1. `open_document(TEXT_PDF)` — viewer should mount.
> 2. `read_document_information()` — capture pageCount, title.
> 3. `get_view_state()` — should report page 0 of N.
> 4. `read_page_info(pageIndex=0)` — capture width/height/rotation.
> 5. `get_page_image(pageIndex=0)` — verify you receive an image
>    content block plus structuredContent with
>    `pageWidth`/`pageHeight`/`renderedWidth`.
> 6. `read_text()` — capture the first ~200 chars; pick a distinctive
>    phrase from the output and remember it for step 8.
> 7. `read_text(pageStart=0, pageEnd=0)` — verify it's a subset of
>    step 6.
> 8. `search_exact_text(query=<phrase from step 6>)` — should return
>    ≥1 hit.
> 9. `search_exact_text(query="ZZZ_no_such_string_ZZZ")` — should
>    return 0 hits.
> 10. `set_view_state(pageIndex=1)` then `get_view_state()` — confirm
>     navigation.
>
> ═══════════════════════════════════════════════════════════
> PHASE 2 — Annotation lifecycle (still TEXT_PDF)
> ═══════════════════════════════════════════════════════════
>
> 11. `create_annotation` — a "note" or "text" annotation on page 0 at
>     a small rect (e.g. `{left:50, top:50, width:120, height:40}`).
>     Capture the id.
> 12. `read_annotations()` — confirm the new id is present.
> 13. `read_annotations(pageIndex=0, type=<the type you created>)` —
>     same id.
> 14. `update_annotation(id=<id>)` — change a visible property (e.g.
>     text or color). Re-read to confirm the patch landed.
> 15. `create_annotation` — a "redaction" annotation on page 0 at a
>     small rect. Capture its id.
> 16. `delete_annotation(id=<the id from step 11>)` —
>     `read_annotations()` to confirm only the redaction remains.
> 17. `apply_annotations()` — REDACTION GATE: the tool description
>     requires you (the model) to confirm in chat. State explicitly:
>     "Confirmed: applying redactions will permanently destroy
>     content." Then call it. If the host advertises elicitation, an
>     in-chat form will appear — accept it. Verify the redaction is
>     now burned in by reading the page text and confirming the
>     redacted region is gone.
>
> ═══════════════════════════════════════════════════════════
> PHASE 3 — In-place document swap → forms (FORM_PDF)
> ═══════════════════════════════════════════════════════════
>
> 18. `open_document(FORM_PDF)` — should be an in-place SDK swap, no
>     blank transitional state. Confirm `get_view_state` reports the
>     new path.
> 19. `read_form_fields()` — capture at least one text field name and
>     one checkbox name.
> 20. `read_form_fields(pageIndex=0)` — page-scoped variant.
> 21. `update_form_field_values` — set the text field to "Test Value"
>     and toggle the checkbox to true. Re-read to confirm both stuck.
> 22. `update_form_field_values` — set the text field to a
>     deliberately invalid value for its type (e.g. an object where a
>     string is expected) — confirm you get an `McpError` with
>     `InvalidParams`.
>
> ═══════════════════════════════════════════════════════════
> PHASE 4 — Teardown + guard checks
> ═══════════════════════════════════════════════════════════
>
> 23. `close_document()` — should succeed.
> 24. `close_document()` — call it again; must be an idempotent no-op.
> 25. `get_view_state()` — should fail with `McpError InvalidParams`
>     "No document is currently open. Call open_document first."
> 26. `read_text()` — same guard, same error.
> 27. `open_document(TEXT_PDF)` again — confirm a fresh session works
>     after full teardown.
> 28. `close_document()` — final cleanup.
>
> ═══════════════════════════════════════════════════════════
> SUMMARY
> ═══════════════════════════════════════════════════════════
>
> Print a table:
>
> | # | Tool | Result | Notes |
> |---|------|--------|-------|
>
> Then state the totals (e.g. "27 PASS / 1 FAIL") and list every FAIL
> with the exact error code and message so it can be triaged.
>
> Two notes:
>
> - The dual-gate on `apply_annotations` means you (the model in
>   Claude Desktop) must say the confirmation sentence in chat before
>   the call, or it will refuse — that's by design (see
>   [`tool-surface.md`](tool-surface.md) § "Public tools" row for
>   `apply_annotations`).
> - All 16 public tools are exercised: `open_document`,
>   `close_document`, `get_view_state`, `set_view_state`,
>   `search_exact_text`, `read_document_information`, `read_page_info`,
>   `get_page_image`, `read_text`, `create_annotation`,
>   `read_annotations`, `update_annotation`, `delete_annotation`,
>   `apply_annotations`, `read_form_fields`,
>   `update_form_field_values`.

## Interpreting failures

- **"MCP client has not advertised any filesystem roots"** — the
  project folder is not attached. Re-attach `tests/fixtures/` and
  start a fresh chat (`roots/list` is captured at `initialize` time).
- **`LICENSE_ERROR` on every guarded tool** — the embedded viewer's
  license failed to load. See `requireValidLicense()` in
  [`tool-surface.md`](tool-surface.md) § "Runtime guards" and the
  license notes in
  [`environment-variables.md`](environment-variables.md).
- **Step 17 refuses without an error** — the model didn't say the
  confirmation sentence verbatim before calling `apply_annotations`.
  This is the intentional model-side gate, not a bug.
- **Step 18 shows a blank transitional state** — regression in the
  in-place SDK swap; see
  [`document-lifecycle.md`](document-lifecycle.md) § "In-place SDK
  swap".
- **Any step hangs past `VIEWER_TIMEOUT_MS`** — the viewer didn't ack
  the round-trip; see [`bridge-protocol.md`](bridge-protocol.md) §
  "Request lifecycle / timeout race" and
  [`environment-variables.md`](environment-variables.md) for the
  timeout knob.
