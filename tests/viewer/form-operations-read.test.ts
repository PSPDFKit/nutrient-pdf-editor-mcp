import { describe, it, expect, vi } from "vitest";
import { readFormFields, type ViewerInstanceMock } from "../../src/viewer/form-operations.js";
import { mockSDK } from "../helpers/form-operations-fakes.js";

describe("readFormFields", () => {
  it("returns InstantJSON-shaped records with widget pageIndex/rect attached", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 2,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.FormFields.TextFormField({
            name: "applicant.name",
            label: "Full Name",
            required: true
          }),
          new sdk.FormFields.CheckBoxFormField({
            name: "applicant.agree",
            label: "I Agree",
            required: false,
            options: [{ value: "Yes", label: "Yes" }],
            defaultValues: []
          }),
          new sdk.FormFields.RadioButtonFormField({
            name: "applicant.choice",
            label: "Choose One",
            required: true,
            options: [
              { value: "A", label: "Option A" },
              { value: "B", label: "Option B" }
            ]
          })
        ]
      }),
      getFormFieldValues: () => ({
        "applicant.name": "John Doe",
        "applicant.agree": "Yes",
        "applicant.choice": "A"
      }),
      getAnnotations: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.Annotations.WidgetAnnotation({
            formFieldName: "applicant.name",
            pageIndex: 0,
            boundingBox: { left: 10, top: 20, width: 100, height: 20 }
          }),
          new sdk.Annotations.WidgetAnnotation({
            formFieldName: "applicant.agree",
            pageIndex: 0,
            boundingBox: { left: 10, top: 50, width: 20, height: 20 }
          }),
          new sdk.Annotations.WidgetAnnotation({
            formFieldName: "applicant.choice",
            pageIndex: 1,
            boundingBox: { left: 10, top: 100, width: 150, height: 30 }
          })
        ]
      }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const fields = await readFormFields(mockInstance, undefined, sdk);

    expect(fields).toHaveLength(3);

    expect(fields[0]!.type).toBe("pspdfkit/form-field/text");
    expect(fields[0]!.name).toBe("applicant.name");
    expect(fields[0]!.value).toBe("John Doe");
    expect(fields[0]!.pageIndex).toBe(0);
    expect((fields[0] as { flags?: Array<string> }).flags).toEqual(["required"]);

    expect(fields[1]!.type).toBe("pspdfkit/form-field/checkbox");
    expect(fields[1]!.name).toBe("applicant.agree");

    expect(fields[2]!.type).toBe("pspdfkit/form-field/radio");
    expect(fields[2]!.pageIndex).toBe(1);
    // Radio options are passed through verbatim from the source field.
    expect((fields[2] as { options?: Array<unknown> }).options).toEqual([
      { value: "A", label: "Option A" },
      { value: "B", label: "Option B" }
    ]);
  });

  it("skips fields the SDK serializer rejects (unknown SDK class)", async () => {
    const sdk = mockSDK();
    class UnknownFormFieldType {
      name = "unknown";
    }
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.FormFields.TextFormField({ name: "text1", required: true }),
          new UnknownFormFieldType()
        ]
      }),
      getFormFieldValues: () => ({ text1: "value" }),
      getAnnotations: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.Annotations.WidgetAnnotation({
            formFieldName: "text1",
            pageIndex: 0,
            boundingBox: { left: 0, top: 0, width: 100, height: 20 }
          }),
          new sdk.Annotations.WidgetAnnotation({
            formFieldName: "unknown",
            pageIndex: 0,
            boundingBox: { left: 0, top: 30, width: 100, height: 20 }
          })
        ]
      }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const fields = await readFormFields(mockInstance, undefined, sdk);

    expect(fields).toHaveLength(1);
    expect(fields[0]!.name).toBe("text1");
  });

  it("filters to specified pageIndex when provided", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 2,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.FormFields.TextFormField({ name: "text1", required: true }),
          new sdk.FormFields.TextFormField({ name: "text2", required: true })
        ]
      }),
      getFormFieldValues: () => ({ text1: "page0", text2: "page1" }),
      getAnnotations: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.Annotations.WidgetAnnotation({
            formFieldName: "text1",
            pageIndex: 0,
            boundingBox: { left: 0, top: 0, width: 100, height: 20 }
          }),
          new sdk.Annotations.WidgetAnnotation({
            formFieldName: "text2",
            pageIndex: 1,
            boundingBox: { left: 0, top: 0, width: 100, height: 20 }
          })
        ]
      }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const fields = await readFormFields(mockInstance, 1, sdk);

    expect(fields).toHaveLength(1);
    expect(fields[0]!.name).toBe("text2");
    expect(fields[0]!.pageIndex).toBe(1);
  });

  it("skips fields without a matching widget annotation", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.FormFields.TextFormField({ name: "text1", required: true }),
          new sdk.FormFields.TextFormField({ name: "orphan", required: true })
        ]
      }),
      getFormFieldValues: () => ({ text1: "value", orphan: "orphaned" }),
      getAnnotations: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.Annotations.WidgetAnnotation({
            formFieldName: "text1",
            pageIndex: 0,
            boundingBox: { left: 0, top: 0, width: 100, height: 20 }
          })
        ]
      }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const fields = await readFormFields(mockInstance, undefined, sdk);

    expect(fields).toHaveLength(1);
    expect(fields[0]!.name).toBe("text1");
  });

  it("returns null values from getFormFieldValues as null", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [new sdk.FormFields.TextFormField({ name: "empty", required: false })]
      }),
      getFormFieldValues: () => ({ empty: null }),
      getAnnotations: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.Annotations.WidgetAnnotation({
            formFieldName: "empty",
            pageIndex: 0,
            boundingBox: { left: 0, top: 0, width: 100, height: 20 }
          })
        ]
      }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const fields = await readFormFields(mockInstance, undefined, sdk);
    expect(fields[0]!.value).toBe(null);
  });

  it("populates values[] when the runtime value is an array (multi-select)", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.FormFields.ListBoxFormField({
            name: "tags",
            label: "Tags",
            options: [
              { value: "red", label: "Red" },
              { value: "blue", label: "Blue" }
            ],
            multiSelect: true,
            defaultValues: []
          })
        ]
      }),
      getFormFieldValues: () => ({ tags: ["red", "blue"] }),
      getAnnotations: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.Annotations.WidgetAnnotation({
            formFieldName: "tags",
            pageIndex: 0,
            boundingBox: { left: 0, top: 0, width: 100, height: 20 }
          })
        ]
      }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const fields = await readFormFields(mockInstance, undefined, sdk);
    expect(fields[0]!.value).toEqual(["red", "blue"]);
    expect(fields[0]!.values).toEqual(["red", "blue"]);
  });
});
