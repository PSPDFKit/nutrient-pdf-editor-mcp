import { describe, it, expect, vi } from "vitest";
import {
  updateFormFieldValues,
  type ViewerInstanceMock
} from "../../src/viewer/form-operations.js";
import { mockSDK } from "../helpers/form-operations-fakes.js";

describe("updateFormFieldValues", () => {
  it("text field: string passes through to instance.setFormFieldValues", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [new sdk.FormFields.TextFormField({ name: "text1", required: true })]
      }),
      getFormFieldValues: () => ({}),
      getAnnotations: vi.fn().mockResolvedValue({ toArray: () => [] }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const result = await updateFormFieldValues(
      mockInstance,
      [{ name: "text1", value: "anything goes here" }],
      sdk
    );

    expect(result.updated.map((u) => u.name)).toEqual(["text1"]);
    expect(result.unresolved).toEqual([]);
    expect(mockInstance.setFormFieldValues).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const passed = (mockInstance.setFormFieldValues as any).mock.calls[0][0];
    expect(passed).toEqual({ text1: "anything goes here" });
  });

  it("text field: null normalizes to empty string", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [new sdk.FormFields.TextFormField({ name: "text1", required: false })]
      }),
      getFormFieldValues: () => ({}),
      getAnnotations: vi.fn().mockResolvedValue({ toArray: () => [] }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const result = await updateFormFieldValues(mockInstance, [{ name: "text1", value: null }], sdk);

    expect(result.updated.map((u) => u.name)).toEqual(["text1"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const passed = (mockInstance.setFormFieldValues as any).mock.calls[0][0];
    expect(passed.text1).toBe("");
  });

  it("checkbox: array value wraps to Immutable.List", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.FormFields.CheckBoxFormField({
            name: "agree",
            options: [{ value: "Yes", label: "Yes" }],
            defaultValues: []
          })
        ]
      }),
      getFormFieldValues: () => ({}),
      getAnnotations: vi.fn().mockResolvedValue({ toArray: () => [] }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const result = await updateFormFieldValues(
      mockInstance,
      [{ name: "agree", value: ["Yes"] }],
      sdk
    );

    expect(result.updated.map((u) => u.name)).toEqual(["agree"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const passed = (mockInstance.setFormFieldValues as any).mock.calls[0][0];
    expect(passed.agree).toEqual(["Yes"]);
  });

  it("checkbox: bare string is leniently wrapped to a single-element list", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.FormFields.CheckBoxFormField({
            name: "agree",
            options: [{ value: "Yes", label: "Yes" }],
            defaultValues: []
          })
        ]
      }),
      getFormFieldValues: () => ({}),
      getAnnotations: vi.fn().mockResolvedValue({ toArray: () => [] }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const result = await updateFormFieldValues(
      mockInstance,
      [{ name: "agree", value: "Yes" }],
      sdk
    );

    expect(result.updated.map((u) => u.name)).toEqual(["agree"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const passed = (mockInstance.setFormFieldValues as any).mock.calls[0][0];
    expect(passed.agree).toEqual(["Yes"]);
  });

  it("checkbox: null clears via empty Immutable.List", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.FormFields.CheckBoxFormField({
            name: "agree",
            options: [{ value: "Yes", label: "Yes" }],
            defaultValues: []
          })
        ]
      }),
      getFormFieldValues: () => ({}),
      getAnnotations: vi.fn().mockResolvedValue({ toArray: () => [] }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const result = await updateFormFieldValues(mockInstance, [{ name: "agree", value: null }], sdk);
    expect(result.updated.map((u) => u.name)).toEqual(["agree"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const passed = (mockInstance.setFormFieldValues as any).mock.calls[0][0];
    expect(passed.agree).toEqual([]);
  });

  it("radio: string passes through; null deselects", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.FormFields.RadioButtonFormField({
            name: "choice",
            options: [
              { value: "A", label: "A" },
              { value: "B", label: "B" }
            ]
          })
        ]
      }),
      getFormFieldValues: () => ({}),
      getAnnotations: vi.fn().mockResolvedValue({ toArray: () => [] }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    let result = await updateFormFieldValues(mockInstance, [{ name: "choice", value: "B" }], sdk);
    expect(result.updated.map((u) => u.name)).toEqual(["choice"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let passed = (mockInstance.setFormFieldValues as any).mock.calls[0][0];
    expect(passed.choice).toBe("B");

    vi.clearAllMocks();
    mockInstance.setFormFieldValues = vi.fn().mockResolvedValue(undefined);
    result = await updateFormFieldValues(mockInstance, [{ name: "choice", value: null }], sdk);
    expect(result.updated.map((u) => u.name)).toEqual(["choice"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    passed = (mockInstance.setFormFieldValues as any).mock.calls[0][0];
    expect(passed.choice).toBeNull();
  });

  it("radio: array value rejected with model-readable reason", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.FormFields.RadioButtonFormField({
            name: "choice",
            options: [{ value: "A", label: "A" }]
          })
        ]
      }),
      getFormFieldValues: () => ({}),
      getAnnotations: vi.fn().mockResolvedValue({ toArray: () => [] }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const result = await updateFormFieldValues(
      mockInstance,
      [{ name: "choice", value: ["A", "B"] }],
      sdk
    );

    expect(result.updated.map((u) => u.name)).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]!.reason).toMatch(/Radio.*string.*null|expects/i);
    expect(mockInstance.setFormFieldValues).not.toHaveBeenCalled();
  });

  it("listbox single-select string passes; multi-select array passes", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.FormFields.ListBoxFormField({
            name: "tags",
            options: [{ value: "red", label: "Red" }],
            multiSelect: true,
            defaultValues: []
          })
        ]
      }),
      getFormFieldValues: () => ({}),
      getAnnotations: vi.fn().mockResolvedValue({ toArray: () => [] }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const result = await updateFormFieldValues(
      mockInstance,
      [{ name: "tags", value: ["red", "blue"] }],
      sdk
    );
    expect(result.updated.map((u) => u.name)).toEqual(["tags"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const passed = (mockInstance.setFormFieldValues as any).mock.calls[0][0];
    expect(passed.tags).toEqual(["red", "blue"]);
  });

  it("reports unknown field names without contacting the SDK", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [new sdk.FormFields.TextFormField({ name: "text1" })]
      }),
      getFormFieldValues: () => ({}),
      getAnnotations: vi.fn().mockResolvedValue({ toArray: () => [] }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const result = await updateFormFieldValues(
      mockInstance,
      [{ name: "unknown_field", value: "value" }],
      sdk
    );

    expect(result.updated.map((u) => u.name)).toEqual([]);
    expect(result.unresolved).toEqual([{ name: "unknown_field", reason: "Unknown field name" }]);
    expect(mockInstance.update).not.toHaveBeenCalled();
  });

  it("handles mixed success and failure with partial commit", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [
          new sdk.FormFields.TextFormField({ name: "text1" }),
          new sdk.FormFields.RadioButtonFormField({
            name: "radio1",
            options: [{ value: "A", label: "A" }]
          })
        ]
      }),
      getFormFieldValues: () => ({}),
      getAnnotations: vi.fn().mockResolvedValue({ toArray: () => [] }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const result = await updateFormFieldValues(
      mockInstance,
      [
        { name: "text1", value: "hello" },
        { name: "radio1", value: ["A", "B"] }, // arrays not allowed for radios
        { name: "ghost", value: "x" } // unknown
      ],
      sdk
    );

    expect(result.updated.map((u) => u.name)).toEqual(["text1"]);
    expect(result.unresolved).toHaveLength(2);
    expect(result.unresolved.map((u) => u.name)).toContain("radio1");
    expect(result.unresolved.map((u) => u.name)).toContain("ghost");
  });

  it("rolls accepted entries back to unresolved when instance.setFormFieldValues throws", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({
        toArray: () => [new sdk.FormFields.TextFormField({ name: "text1" })]
      }),
      getFormFieldValues: () => ({}),
      getAnnotations: vi.fn().mockResolvedValue({ toArray: () => [] }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockRejectedValue(new Error("SDK error"))
    };

    const result = await updateFormFieldValues(mockInstance, [{ name: "text1", value: "hi" }], sdk);

    expect(result.updated.map((u) => u.name)).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]!.name).toBe("text1");
    expect(result.unresolved[0]!.reason).toBe("SDK error");
  });

  it("returns empty result for an empty input list and never calls instance.setFormFieldValues", async () => {
    const sdk = mockSDK();
    const mockInstance: ViewerInstanceMock = {
      totalPageCount: 1,
      getFormFields: vi.fn().mockResolvedValue({ toArray: () => [] }),
      getFormFieldValues: () => ({}),
      getAnnotations: vi.fn().mockResolvedValue({ toArray: () => [] }),
      update: vi.fn().mockResolvedValue([]),
      setFormFieldValues: vi.fn().mockResolvedValue(undefined)
    };

    const result = await updateFormFieldValues(mockInstance, [], sdk);

    expect(result.updated.map((u) => u.name)).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(mockInstance.update).not.toHaveBeenCalled();
  });
});
