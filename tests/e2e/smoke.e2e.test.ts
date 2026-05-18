import { describe, it, expect } from "vitest";
import { withScenario } from "./harness/scenario.js";
import { openDocument, waitForViewerInstance } from "./harness/helpers.js";
import { FIXTURE_ROOTS, SAMPLE_PDF } from "./harness/fixtures.js";

const EXPECTED_TOOLS = [
  "open_document",
  "close_document",
  "get_view_state",
  "set_view_state",
  "search_exact_text",
  "read_document_information",
  "read_page_info",
  "get_page_image",
  "read_text",
  "create_annotation",
  "read_annotations",
  "update_annotation",
  "delete_annotation",
  "apply_annotations",
  "read_form_fields",
  "update_form_field_values"
];

describe("smoke e2e", () => {
  it("tools/list advertises every public tool", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async ({ client }) => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      for (const expected of EXPECTED_TOOLS) {
        expect(names).toContain(expected);
      }
    });
  });

  it("open_document round-trips through the real viewer", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openDocument(ctx, SAMPLE_PDF);
      await waitForViewerInstance(ctx.page);
    });
  });
});
