/**
 * Shared SDK stub for form-operations tests.
 *
 * Provides real classes so `instanceof` checks resolve correctly, a working
 * `FormFields.toSerializableObject` that mirrors the real SDK's serializer for
 * the field shapes the tests construct, and a minimal `Immutable.List` and
 * `FormFieldValue` for the update path.
 *
 * NOTE: This file must NOT use vi.mock / vi.hoisted — it is a plain helper
 * module imported by the split test files.
 */
export function mockSDK() {
  type AnyOpts = Record<string, unknown>;
  const makeClass = () =>
    class {
      constructor(opts: AnyOpts = {}) {
        Object.assign(this, opts);
      }
    };

  const TextFormField = makeClass();
  const CheckBoxFormField = makeClass();
  const RadioButtonFormField = makeClass();
  const ChoiceFormField = makeClass();
  // ComboBox/ListBox extend ChoiceFormField in the real SDK, so make them
  // subclasses here so `instanceof ChoiceFormField` matches.
  class ComboBoxFormField extends ChoiceFormField {}
  class ListBoxFormField extends ChoiceFormField {}

  /**
   * Mimic the SDK's serializer: walk the public fields off the instance and
   * emit an InstantJSON-shaped record. Field-class identity drives the
   * discriminator — same way the real `serializeFormField` works.
   */
  function toSerializableObject(field: unknown): Record<string, unknown> {
    const f = field as Record<string, unknown>;
    const common = {
      v: 1,
      id: f.id ?? "id-mock",
      pdfObjectId: f.pdfObjectId ?? 0,
      name: f.name,
      annotationIds: f.annotationIds ?? [],
      label: f.label,
      additionalActions: f.additionalActions,
      ...(f.required ? { flags: ["required"] } : {})
    };
    if (field instanceof TextFormField) {
      return { ...common, type: "pspdfkit/form-field/text", defaultValue: "" };
    }
    if (field instanceof CheckBoxFormField) {
      return {
        ...common,
        type: "pspdfkit/form-field/checkbox",
        options: (f.options as Array<unknown>) ?? [],
        defaultValues: (f.defaultValues as Array<string>) ?? []
      };
    }
    if (field instanceof RadioButtonFormField) {
      return {
        ...common,
        type: "pspdfkit/form-field/radio",
        options: (f.options as Array<unknown>) ?? [],
        noToggleToOff: false,
        radiosInUnison: false,
        defaultValue: ""
      };
    }
    if (field instanceof ComboBoxFormField) {
      return {
        ...common,
        type: "pspdfkit/form-field/combobox",
        options: (f.options as Array<unknown>) ?? [],
        multiSelect: (f.multiSelect as boolean) ?? false,
        commitOnChange: false,
        defaultValues: [],
        edit: (f.edit as boolean) ?? false,
        doNotSpellCheck: false
      };
    }
    if (field instanceof ListBoxFormField) {
      return {
        ...common,
        type: "pspdfkit/form-field/listbox",
        options: (f.options as Array<unknown>) ?? [],
        multiSelect: (f.multiSelect as boolean) ?? false,
        commitOnChange: false,
        defaultValues: []
      };
    }
    throw new Error(`Unsupported form field class for ${String(f.name)}`);
  }

  const WidgetAnnotation = makeClass();

  // Minimal Immutable.List stand-in: identity preserved + .toArray() for the
  // duck-typed validator. Tests assert against the wrapped array contents.
  function ImmutableList(arr: ReadonlyArray<unknown> = []) {
    const data = [...arr];
    return {
      __list: true,
      toArray: () => data
    };
  }

  class FormFieldValue {
    name: string;
    value: unknown;
    constructor(opts: { name: string; value: unknown }) {
      this.name = opts.name;
      this.value = opts.value;
    }
  }

  return {
    FormFields: {
      TextFormField,
      CheckBoxFormField,
      RadioButtonFormField,
      ChoiceFormField,
      ComboBoxFormField,
      ListBoxFormField,
      toSerializableObject
    },
    Annotations: { WidgetAnnotation },
    Immutable: { List: ImmutableList },
    FormFieldValue
  };
}
