import { describe, it, expect } from "vitest";
import {
  formatAnnotations,
  formatDocumentInfo,
  formatFormFields,
  formatFormFieldsUpdated,
  formatPageImageMetadata,
  formatPageInfo,
  formatTextSearchResults
} from "../../src/mcp/formatters.js";
import type { MCPFormField } from "../../src/mcp/formatters.js";
import { makeMCPFormField } from "../helpers/makeMCPFormField.js";

describe("formatFormFields", () => {
  it("returns an empty-state message scoped to a page when no fields", () => {
    const out = formatFormFields([], 3);
    expect(out).toContain("No form fields found in page 3");
  });

  it("returns an empty-state message scoped to whole document when no pageIndex", () => {
    const out = formatFormFields([]);
    expect(out).toContain("No form fields found in the entire document");
  });

  it("renders a text field with label, identifier, value, required", () => {
    const fields: Array<MCPFormField> = [
      makeMCPFormField({
        id: "id-text",
        name: "applicant.name",
        label: "Full Name",
        flags: ["required"],
        value: "Jane Doe"
      })
    ];

    const out = formatFormFields(fields);
    expect(out).toContain("## Full Name");
    expect(out).toContain("**Identifier:** applicant.name");
    expect(out).toContain("**Type:** text");
    expect(out).toContain("**Value:** Jane Doe");
    expect(out).toContain("**Required:** Yes");
  });

  it("renders 'Not set' when value is null", () => {
    const fields: Array<MCPFormField> = [makeMCPFormField({ value: null })];
    expect(formatFormFields(fields)).toContain("**Value:** Not set");
  });

  it("renders an array value as quoted comma-separated list", () => {
    const fields: Array<MCPFormField> = [
      makeMCPFormField({
        type: "pspdfkit/form-field/listbox",
        name: "tags",
        label: "Tags",
        options: [
          { value: "red", label: "Red" },
          { value: "blue", label: "Blue" }
        ],
        multiSelect: true,
        commitOnChange: false,
        defaultValues: [],
        value: ["red", "blue"]
      })
    ];
    expect(formatFormFields(fields)).toContain('**Value:** "red", "blue"');
  });

  it("emits options with both value and label when they differ", () => {
    const fields: Array<MCPFormField> = [
      makeMCPFormField({
        type: "pspdfkit/form-field/combobox",
        name: "country",
        label: "Country",
        options: [
          { value: "GB", label: "United Kingdom" },
          { value: "US", label: "United States" }
        ],
        multiSelect: false,
        commitOnChange: false,
        defaultValues: [],
        edit: false,
        doNotSpellCheck: false
      })
    ];

    const out = formatFormFields(fields);
    expect(out).toContain('**Options:** "GB" (United Kingdom), "US" (United States)');
  });

  it("omits the label parenthesis when value === label", () => {
    const fields: Array<MCPFormField> = [
      makeMCPFormField({
        type: "pspdfkit/form-field/radio",
        name: "color",
        label: "Color",
        options: [
          { value: "Red", label: "Red" },
          { value: "Blue", label: "Blue" }
        ],
        noToggleToOff: false,
        radiosInUnison: false,
        defaultValue: ""
      })
    ];

    const out = formatFormFields(fields);
    expect(out).toContain('**Options:** "Red", "Blue"');
    expect(out).not.toContain("(Red)");
  });

  it("includes the checkbox/radio uncheck note", () => {
    const fields: Array<MCPFormField> = [
      makeMCPFormField({
        type: "pspdfkit/form-field/checkbox",
        name: "agree",
        label: "I Agree",
        options: [{ value: "Yes", label: "Yes" }],
        defaultValues: []
      })
    ];

    const out = formatFormFields(fields);
    expect(out).toContain("Use one of the options above to check, or pass null to uncheck");
  });

  it("emits the editable hint for combobox with edit: true", () => {
    const fields: Array<MCPFormField> = [
      makeMCPFormField({
        type: "pspdfkit/form-field/combobox",
        name: "occupation",
        label: "Occupation",
        options: [{ value: "Engineer", label: "Engineer" }],
        multiSelect: false,
        commitOnChange: false,
        defaultValues: [],
        edit: true,
        doNotSpellCheck: false
      })
    ];

    expect(formatFormFields(fields)).toContain("**Editable:** Yes");
  });

  it("emits the multi-select hint when multiSelect is true", () => {
    const fields: Array<MCPFormField> = [
      makeMCPFormField({
        type: "pspdfkit/form-field/listbox",
        name: "tags",
        label: "Tags",
        options: [{ value: "a", label: "A" }],
        multiSelect: true,
        commitOnChange: false,
        defaultValues: []
      })
    ];

    expect(formatFormFields(fields)).toContain("**Multi-select:** Yes");
  });

  it("renders Required: No when no flags array", () => {
    const fields: Array<MCPFormField> = [makeMCPFormField()];
    expect(formatFormFields(fields)).toContain("**Required:** No");
  });

  it("ends with the labels-vs-identifiers IMPORTANT note", () => {
    const fields: Array<MCPFormField> = [makeMCPFormField()];
    const out = formatFormFields(fields);
    expect(out).toContain("IMPORTANT:");
    expect(out).toContain("always use the field heading");
    expect(out).toContain("Never expose the internal identifier");
  });
});

describe("formatFormFieldsUpdated", () => {
  it("renders the success message with the count", () => {
    expect(formatFormFieldsUpdated(3)).toContain("Successfully updated 3 form field(s)");
  });

  it("instructs the model to refer to fields by label", () => {
    expect(formatFormFieldsUpdated(1)).toContain("by their labels");
  });
});

describe("formatDocumentInfo", () => {
  it("renders title, author, page count, and permissions", () => {
    const out = formatDocumentInfo({
      title: "Annual Report",
      author: "Finance Team",
      pageCount: 42,
      permissions: { printing: true, modification: false }
    });
    expect(out).toContain("# Document Information");
    expect(out).toContain("**Title:** Annual Report");
    expect(out).toContain("**Author:** Finance Team");
    expect(out).toContain("**Pages:** 42");
    expect(out).toContain("## Permissions");
    expect(out).toContain("**printing**: allowed");
    expect(out).toContain("**modification**: not allowed");
  });

  it("falls back to 'Unknown' for missing scalars", () => {
    const out = formatDocumentInfo({});
    expect(out).toContain("**Title:** Unknown");
    expect(out).toContain("**Author:** Unknown");
    expect(out).toContain("**Pages:** Unknown");
  });

  it("omits the Permissions section when permissions are not provided", () => {
    const out = formatDocumentInfo({ title: "X", pageCount: 1 });
    expect(out).not.toContain("## Permissions");
  });
});

describe("formatPageInfo", () => {
  it("renders dimensions in points with origin guidance", () => {
    const out = formatPageInfo({ pageIndex: 0, width: 612, height: 792, rotation: 0 });
    expect(out).toContain("# Page 0 Information");
    expect(out).toContain("**Width:** 612 points");
    expect(out).toContain("**Height:** 792 points");
    expect(out).toContain("**Rotation:** 0°");
    expect(out).toContain("origin at top-left");
  });

  it("defaults rotation to 0 when omitted", () => {
    const out = formatPageInfo({ pageIndex: 1, width: 100, height: 200 });
    expect(out).toContain("**Rotation:** 0°");
  });
});

describe("formatAnnotations", () => {
  it("renders an empty-state message scoped to a page", () => {
    expect(formatAnnotations([], 2)).toContain("No annotations found in page 2");
  });

  it("renders an empty-state message with a type filter", () => {
    expect(formatAnnotations([], undefined, "highlight")).toContain('with type "highlight"');
  });

  it("renders annotations with type, page, and contents from the short-form shape", () => {
    const out = formatAnnotations([
      { id: "ann-1", type: "highlight", pageIndex: 0, contents: "important quote" },
      { id: "ann-2", type: "note", pageIndex: 3 }
    ]);
    expect(out).toContain("# Annotations");
    expect(out).toContain("## Annotation ann-1");
    expect(out).toContain("**Type:** highlight");
    expect(out).toContain("**Page:** 0");
    expect(out).toContain("important quote");
    expect(out).toContain("## Annotation ann-2");
    expect(out).toContain("**Type:** note");
  });

  it("strips InstantJSON namespace prefixes from the type when present", () => {
    const out = formatAnnotations([{ id: "x", type: "pspdfkit/markup/highlight", pageIndex: 0 }]);
    expect(out).toContain("**Type:** highlight");
    expect(out).not.toContain("pspdfkit/markup/highlight");
  });

  it("includes Author/Created lines only when those fields are present", () => {
    const withMeta = formatAnnotations([
      { id: "a", type: "note", pageIndex: 0, creatorName: "Alice", createdAt: "2026-04-01" }
    ]);
    expect(withMeta).toContain("**Author:** Alice");
    expect(withMeta).toContain("**Created:** 2026-04-01");

    const withoutMeta = formatAnnotations([{ id: "a", type: "note", pageIndex: 0 }]);
    expect(withoutMeta).not.toContain("Author");
    expect(withoutMeta).not.toContain("Created");
  });

  it("extracts contents from the normalized `contents` field", () => {
    // The viewer normalizes all annotation text to `contents` before bridging.
    // The old `text.value` InstantJSON migration branch has been removed.
    const out = formatAnnotations([
      {
        id: "t",
        type: "pspdfkit/text",
        pageIndex: 0,
        contents: "hello world"
      }
    ]);
    expect(out).toContain("hello world");
  });
});

describe("formatTextSearchResults", () => {
  it("renders zero-matches message", () => {
    expect(formatTextSearchResults({ searchTerm: "foo", hits: [] })).toContain(
      'No matches found for "foo"'
    );
  });

  it("renders the search term, total count, and per-match details", () => {
    const out = formatTextSearchResults({
      searchTerm: "invoice",
      hits: [
        {
          pageIndex: 2,
          previewText: "Invoice #1234",
          rect: { left: 72.0, top: 100.5, width: 50.25, height: 12.0 }
        }
      ]
    });
    expect(out).toContain('**Search term:** "invoice"');
    expect(out).toContain("**Total matches:** 1");
    expect(out).toContain("## Match 1");
    expect(out).toContain("**Page:** 2");
    expect(out).toContain('**Preview:** "Invoice #1234"');
    expect(out).toContain("left: 72.00");
    expect(out).toContain("top: 100.50");
  });
});

describe("formatPageImageMetadata", () => {
  it("renders dimensions and the pixel→points scale factor", () => {
    const out = formatPageImageMetadata(0, 612, 792, 1024);
    expect(out).toContain("Page 0 dimensions");
    expect(out).toContain("Page size: 612.00 × 792.00 points");
    expect(out).toContain("Rendered image size: 1024 pixels");
    // 612/1024 ≈ 0.5977
    expect(out).toContain("Scale factor: 0.5977 points per pixel");
  });
});
