import { describe, it, expect } from "vitest";
import { withScenario } from "./harness/scenario.js";
import { openAndWait, type RawToolResult } from "./harness/helpers.js";
import {
  FIXTURE_ROOTS,
  FORM_EXAMPLE_PDF,
  SAMPLE_PDF,
  SIGN_OFF_PDF
} from "./harness/fixtures.js";

// sample.pdf: no AcroForm — empty-state coverage.
// form_example.pdf: minimal AcroForm fixture used for the schema-shape
//   assertion (we don't pin specific types so it survives changes to
//   the fixture).
// sign-off/human-resources-form.pdf: the canonical AcroForm dogfood
//   target — known to contain text fields ("City", "ZIP", "Last name ",
//   etc.) and checkboxes ("Master", "Bachelor", "PhD", ...) with the
//   single on-value "Yes". Field names are used verbatim including
//   trailing whitespace where the PDF declares it.

interface ReadFormFieldsResult {
  isError?: boolean;
  structuredContent?: {
    fields?: Array<{
      name: string;
      type: string;
      pageIndex: number;
      value?: unknown;
      rect?: { left: number; top: number; width: number; height: number };
    }>;
  };
}

interface UpdateResult {
  isError?: boolean;
  content?: Array<{ text?: string }>;
  structuredContent?: {
    updated?: Array<{ name: string; value: string | string[] | null }>;
    unresolved?: Array<{ name: string; reason: string }>;
  };
}

describe("form fields (empty-state coverage)", () => {
  it("read_form_fields returns an empty array for a PDF without AcroForm", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = (await ctx.client.callTool("read_form_fields", {})) as
        ReadFormFieldsResult;

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.fields).toEqual([]);
    });
  });

  it("update_form_field_values reports all requested fields as unresolved", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SAMPLE_PDF);

      const result = (await ctx.client.callTool("update_form_field_values", {
        formFieldValues: [
          { name: "name", value: "Ada Lovelace" },
          { name: "state", value: "CA" }
        ]
      })) as UpdateResult;

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.updated).toEqual([]);
      const unresolved = result.structuredContent?.unresolved ?? [];
      const names = unresolved.map((u) => u.name).sort();
      expect(names).toEqual(["name", "state"]);
      for (const u of unresolved) {
        expect(u.reason).toMatch(/\S+/);
      }
    });
  });
});

describe("form fields (schema shape — form_example.pdf)", () => {
  it("read_form_fields returns AcroForm fields with the SDK's discriminator", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, FORM_EXAMPLE_PDF);

      const result = (await ctx.client.callTool("read_form_fields", {})) as
        ReadFormFieldsResult;

      expect(result.isError).toBeFalsy();
      const fields = result.structuredContent?.fields ?? [];
      expect(fields.length).toBeGreaterThan(0);
      for (const f of fields) {
        expect(f.name).toMatch(/\S+/);
        // SDK FormFields.toSerializableObject emits a discriminated union keyed
        // by the PSPDFKit form-field URI; we don't pin individual types here so
        // the test stays green regardless of which fixture contains which field.
        expect(f.type).toMatch(/^pspdfkit\/form-field\//);
        expect(typeof f.pageIndex).toBe("number");
      }
    });
  });
});

describe("form fields (real AcroForm — sign-off pack)", () => {
  it("read_form_fields enumerates fields with full schema metadata", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SIGN_OFF_PDF);

      const result = (await ctx.client.callTool("read_form_fields", {})) as
        ReadFormFieldsResult;

      expect(result.isError).toBeFalsy();
      const fields = result.structuredContent?.fields ?? [];
      expect(fields.length).toBeGreaterThan(5); // sign-off is a real form, dozens of fields

      for (const f of fields) {
        expect(f.name.length).toBeGreaterThan(0);
        expect(f.type).toMatch(/^pspdfkit\/form-field\//);
        expect(typeof f.pageIndex).toBe("number");
        expect(f.rect).toBeDefined();
        expect(f.rect!.width).toBeGreaterThan(0);
        expect(f.rect!.height).toBeGreaterThan(0);
      }

      // Spot-check that the well-known fields are present (these are the
      // names the update tests below rely on).
      const names = new Set(fields.map((f) => f.name));
      expect(names.has("City")).toBe(true);
      expect(names.has("ZIP")).toBe(true);
      expect(names.has("Master")).toBe(true);
      expect(names.has("Bachelor")).toBe(true);
    });
  });

  it("read_form_fields scoped to pageIndex: 0 returns only page-0 fields", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SIGN_OFF_PDF);

      const scoped = (await ctx.client.callTool("read_form_fields", {
        pageIndex: 0
      })) as ReadFormFieldsResult;

      expect(scoped.isError).toBeFalsy();
      const fields = scoped.structuredContent?.fields ?? [];
      expect(fields.length).toBeGreaterThan(0);
      for (const f of fields) {
        expect(f.pageIndex).toBe(0);
      }
    });
  });

  it("update_form_field_values: text fields update and read back", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      const pdf = await ctx.copyFixture(SIGN_OFF_PDF);
      await openAndWait(ctx, pdf);

      const result = (await ctx.client.callTool("update_form_field_values", {
        formFieldValues: [
          { name: "City", value: "Boston" },
          { name: "ZIP", value: "02110" }
        ]
      })) as UpdateResult;

      expect(result.isError).toBeFalsy();
      const updated = result.structuredContent?.updated ?? [];
      const updatedMap = new Map(updated.map((u) => [u.name, u.value]));
      expect(updatedMap.get("City")).toBe("Boston");
      expect(updatedMap.get("ZIP")).toBe("02110");
      expect(result.structuredContent?.unresolved ?? []).toEqual([]);

      // Confirm via read-back: the field's value field reflects the write.
      const readBack = (await ctx.client.callTool("read_form_fields", {})) as
        ReadFormFieldsResult;
      const cityField = readBack.structuredContent?.fields?.find((f) => f.name === "City");
      expect(cityField?.value).toBe("Boston");
    });
  });

  it("update_form_field_values: checkbox set to [\"Yes\"] then cleared with []", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      const pdf = await ctx.copyFixture(SIGN_OFF_PDF);
      await openAndWait(ctx, pdf);

      const checked = (await ctx.client.callTool("update_form_field_values", {
        formFieldValues: [{ name: "Master", value: ["Yes"] }]
      })) as UpdateResult;

      expect(checked.isError).toBeFalsy();
      const checkedEntry = checked.structuredContent?.updated?.find((u) => u.name === "Master");
      expect(checkedEntry).toBeDefined();
      expect(Array.isArray(checkedEntry?.value) ? checkedEntry?.value : []).toContain("Yes");

      const cleared = (await ctx.client.callTool("update_form_field_values", {
        formFieldValues: [{ name: "Master", value: [] }]
      })) as UpdateResult;

      expect(cleared.isError).toBeFalsy();
      const clearedEntry = cleared.structuredContent?.updated?.find((u) => u.name === "Master");
      expect(clearedEntry).toBeDefined();
      // Cleared checkbox: the SDK reports an empty list (or "Off" which it
      // normalises to). Either way: no "Yes" present.
      const clearedValue = clearedEntry?.value;
      expect(Array.isArray(clearedValue) ? clearedValue : []).not.toContain("Yes");
    });
  });

  it("update_form_field_values: bare string for a checkbox is wrapped to [string]", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      const pdf = await ctx.copyFixture(SIGN_OFF_PDF);
      await openAndWait(ctx, pdf);

      // Per src/viewer/form-operations.ts#normalizeValue, a bare string for
      // a checkbox is wrapped via Immutable.List([value]). Verify the
      // ergonomic LLM-input path actually works end-to-end.
      const result = (await ctx.client.callTool("update_form_field_values", {
        formFieldValues: [{ name: "Bachelor", value: "Yes" }]
      })) as UpdateResult;

      expect(result.isError).toBeFalsy();
      const entry = result.structuredContent?.updated?.find((u) => u.name === "Bachelor");
      expect(entry).toBeDefined();
      expect(Array.isArray(entry?.value) ? entry?.value : []).toContain("Yes");
    });
  });

  it("update_form_field_values: unknown field name is reported in unresolved", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      const pdf = await ctx.copyFixture(SIGN_OFF_PDF);
      await openAndWait(ctx, pdf);

      const result = (await ctx.client.callTool("update_form_field_values", {
        formFieldValues: [
          { name: "City", value: "Brooklyn" }, // valid
          { name: "NotAFieldInThisPdf", value: "x" } // invalid
        ]
      })) as UpdateResult;

      expect(result.isError).toBeFalsy();
      const updated = result.structuredContent?.updated ?? [];
      const unresolved = result.structuredContent?.unresolved ?? [];
      expect(updated.some((u) => u.name === "City")).toBe(true);
      const badEntry = unresolved.find((u) => u.name === "NotAFieldInThisPdf");
      expect(badEntry).toBeDefined();
      expect(badEntry?.reason).toMatch(/unknown field name/i);
    });
  });

  it("update_form_field_values: array passed for a text field is rejected as type-mismatch", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      const pdf = await ctx.copyFixture(SIGN_OFF_PDF);
      await openAndWait(ctx, pdf);

      const result = (await ctx.client.callTool("update_form_field_values", {
        formFieldValues: [
          { name: "City", value: ["Boston", "Brooklyn"] } // text fields don't accept arrays
        ]
      })) as UpdateResult;

      expect(result.isError).toBeFalsy();
      const updated = result.structuredContent?.updated ?? [];
      const unresolved = result.structuredContent?.unresolved ?? [];
      expect(updated).toEqual([]);
      const cityErr = unresolved.find((u) => u.name === "City");
      expect(cityErr).toBeDefined();
      // form-operations.ts validateFormFieldValue produces "Text field
      // requires a string, got array".
      expect(cityErr?.reason).toMatch(/text field/i);
    });
  });

  it("update_form_field_values: empty formFieldValues array is rejected by the schema", async () => {
    await withScenario({ roots: FIXTURE_ROOTS }, async (ctx) => {
      await openAndWait(ctx, SIGN_OFF_PDF);

      const result = (await ctx.client.callTool("update_form_field_values", {
        formFieldValues: []
      })) as RawToolResult;

      expect(result.isError).toBe(true);
    });
  });
});
