/**
 * Pure functions for form field reading and updating.
 *
 * `readFormFields` returns SDK-serialized InstantJSON form-field records
 * augmented with the widget's pageIndex/rect and the runtime value(s).
 *
 * `updateFormFieldValues` takes a list of `{name, value: string | string[] | null}`
 * tuples, normalizes the value per the field's type (lenient about a bare
 * string for checkbox/choice fields), validates against the SDK's per-type
 * rules, and submits via the public `instance.update([new FormFieldValue(...)])`
 * path so PDF JS actions and the SDK's own write-time validation run.
 *
 * Both functions are tested with a `ViewerInstanceMock` and a stub SDK that
 * provides real classes for `instanceof` discrimination.
 */

import type { MCPFormField } from "./form-types.js";

/**
 * Surface of the SDK's `Instance` we use here.
 *
 * `getFormFields` / `getAnnotations` return `Immutable.List` from the SDK; we
 * type them loosely as `any` because the SDK's TS exports don't carry full
 * generic narrowing for these. `getFormFieldValues` is SYNCHRONOUS — pitfall 3.
 *
 * `update` accepts an array of `FormFieldValue` instances and returns the
 * resolved changes. We use it instead of the legacy `setFormFieldValues` so
 * PDF JavaScript actions and SDK-side validation execute on the write path.
 */
export interface ViewerInstanceMock {
  totalPageCount: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getFormFields(): any;
  getFormFieldValues(): Record<string, string | null | string[]>;
  /**
   * Public SDK API for programmatic value writes. The SDK's `Instance#update`
   * accepts `FormFieldValue` instances per the `Change` type union, but
   * empirically those writes do NOT commit through to `getFormFieldValues`
   * for text/checkbox fields without a UI focus event — `commitOnChange`
   * defaults to false. `setFormFieldValues` is documented as the
   * value-modification path (see `dist/index.d.ts` example) and resolves
   * once the values have been committed.
   */
  setFormFieldValues(values: Record<string, null | string | string[]>): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAnnotations(pageIndex: number): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(changes: any): Promise<unknown>;
}

/**
 * One entry in the input to `updateFormFieldValues`.
 */
export type FormFieldValueInput = {
  name: string;
  value: string | string[] | null;
};

/**
 * Result of an update batch — partial success is allowed.
 *
 * `updated` carries the post-update value of each successful field as
 * reported by `instance.getFormFieldValues()` after the write completes.
 * This lets the calling agent verify the field state without a follow-up
 * `read_form_fields` call. `unresolved` carries the offending name plus a
 * model-readable reason for each rejected entry.
 */
export type UpdateFormFieldValuesResult = {
  updated: Array<{ name: string; value: string | string[] | null }>;
  unresolved: Array<{ name: string; reason: string }>;
};

/**
 * Read all form fields from the document, optionally scoped to a single page.
 *
 * Output shape: `MCPFormField[]` — the SDK's discriminated `FormFieldJSON`
 * variant for each field, plus runtime `value` / `values` and per-widget
 * `pageIndex` / `rect`. Fields without a matching widget annotation are
 * skipped (they have no displayable position).
 */
export async function readFormFields(
  instance: ViewerInstanceMock,
  pageIndex: number | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  NutrientSDK: any
): Promise<MCPFormField[]> {
  const fieldsList = await instance.getFormFields();
  const valuesMap = instance.getFormFieldValues(); // SYNCHRONOUS — do NOT await
  const WidgetAnnotation = NutrientSDK?.Annotations?.WidgetAnnotation;
  const toSerializable = NutrientSDK?.FormFields?.toSerializableObject as
    | ((f: unknown) => unknown)
    | undefined;

  if (!toSerializable) return []; // SDK didn't expose the serializer — bail entire scan

  const widgets = await collectWidgets(instance, pageIndex, WidgetAnnotation);

  const out: MCPFormField[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const f of fieldsList.toArray() as any[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const widget = widgets.find((w: any) => w.formFieldName === f.name);
    if (!widget) continue;
    if (pageIndex != null && widget.pageIndex !== pageIndex) continue;

    const record = serializeField(f, widget, valuesMap, toSerializable);
    if (record) out.push(record);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers for readFormFields — not exported.
// ---------------------------------------------------------------------------

/**
 * Walk the requested page(s) and return all widget annotations found.
 * When `pageIndex` is undefined every page is scanned.
 */
async function collectWidgets(
  instance: ViewerInstanceMock,
  pageIndex: number | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  WidgetAnnotation: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  const pagesToScan =
    pageIndex != null ? [pageIndex] : Array.from({ length: instance.totalPageCount }, (_, i) => i);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const widgets: any[] = [];
  for (const p of pagesToScan) {
    const anns = await instance.getAnnotations(p);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const a of anns.toArray() as any[]) {
      const isWidget = WidgetAnnotation
        ? a instanceof WidgetAnnotation
        : a?.constructor?.name === "WidgetAnnotation";
      if (isWidget) widgets.push(a);
    }
  }
  return widgets;
}

/**
 * Serialize a single form field to `MCPFormField`, augmented with the widget's
 * `pageIndex` / `rect` and the runtime value from `valuesMap`.
 * Returns `null` when the SDK cannot serialize the field (field is dropped).
 */
function serializeField(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  field: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  widget: any,
  valuesMap: Record<string, string | null | string[]>,
  toSerializable: (f: unknown) => unknown
): MCPFormField | null {
  let json: unknown;
  try {
    json = toSerializable(field);
  } catch {
    return null; // SDK rejected serialization (e.g. unknown form-field class) → skip
  }
  if (json == null || typeof json !== "object") return null;

  const rawValue = valuesMap[field.name];
  const value = rawValue ?? null;
  const values = Array.isArray(rawValue) ? rawValue : undefined;

  return {
    ...(json as MCPFormField),
    value,
    ...(values ? { values } : {}),
    pageIndex: widget.pageIndex,
    rect: {
      left: widget.boundingBox.left,
      top: widget.boundingBox.top,
      width: widget.boundingBox.width,
      height: widget.boundingBox.height
    }
  };
}

/**
 * Update form field values with per-type lenient normalization.
 *
 * Lenience layer:
 *   - text → string passes through; null → "" so the field clears
 *   - radio → string passes through; null → null (deselect)
 *   - checkbox / choice (combobox/listbox) → string wraps to `List([value])`,
 *     array wraps to `List(arr)`, null → empty `List()`
 *
 * Validation layer (the SDK's per-type rules aren't exported from
 * `@nutrient-sdk/viewer` but their three branches are stable across SDK
 * versions):
 *   - text → must be string
 *   - radio → must be string or null
 *   - checkbox/choice → must be Immutable.List
 *
 * Submit: builds a `Record<name, value>` of accepted entries and calls
 * `instance.setFormFieldValues(record)`, which the SDK documents as the
 * value-modification path. The earlier implementation used
 * `instance.update([new FormFieldValue(...)])` aiming to run PDF JS
 * actions + write-time validation, but those updates didn't commit
 * through to `getFormFieldValues` for text/checkbox fields without a UI
 * focus event (see `commitOnChange` default = false in the SDK type
 * docs). `setFormFieldValues` resolves once committed.
 *
 * Returns partial success: each rejected entry is reported in `unresolved`
 * with a model-readable reason; no exceptions are thrown.
 */
export async function updateFormFieldValues(
  instance: ViewerInstanceMock,
  values: ReadonlyArray<FormFieldValueInput>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  NutrientSDK: any
): Promise<UpdateFormFieldValuesResult> {
  const fieldsList = await instance.getFormFields();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fieldMap = new Map<string, any>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fieldsList.toArray().map((f: any) => [f.name, f] as [string, any])
  );

  const FF = NutrientSDK?.FormFields;
  const ImmutableList = NutrientSDK?.Immutable?.List;
  if (!FF || !ImmutableList) {
    return {
      updated: [],
      unresolved: values.map(({ name }) => ({
        name,
        reason: "SDK form-field APIs unavailable"
      }))
    };
  }

  const accepted: string[] = [];
  const unresolved: Array<{ name: string; reason: string }> = [];
  const valuesToWrite: Record<string, null | string | string[]> = {};

  for (const { name, value } of values) {
    const f = fieldMap.get(name);
    if (!f) {
      unresolved.push({ name, reason: "Unknown field name" });
      continue;
    }

    const normalized = normalizeValue(f, value, FF, ImmutableList);
    if (typeof normalized === "string") {
      unresolved.push({ name, reason: normalized });
      continue;
    }

    const validateError = validateFormFieldValue(f, normalized.value, FF);
    if (validateError) {
      unresolved.push({ name, reason: validateError });
      continue;
    }

    // setFormFieldValues accepts plain `string | string[] | null`. The
    // checkbox/choice path normalises to `Immutable.List<string>` for the
    // validator's benefit; convert back to a plain array here.
    const normalizedValue = normalized.value;
    let writeValue: null | string | string[];
    if (
      normalizedValue != null &&
      typeof normalizedValue === "object" &&
      typeof (normalizedValue as { toArray?: unknown }).toArray === "function"
    ) {
      writeValue = (normalizedValue as { toArray: () => unknown[] })
        .toArray()
        .map((v) => String(v));
    } else if (typeof normalizedValue === "string" || normalizedValue === null) {
      writeValue = normalizedValue;
    } else {
      // normalizeValue returned an unknown shape — should be unreachable;
      // surface as a per-field error rather than crash the batch.
      unresolved.push({
        name,
        reason: `Unexpected normalized value type: ${typeof normalizedValue}`
      });
      continue;
    }

    valuesToWrite[name] = writeValue;
    accepted.push(name);
  }

  if (accepted.length === 0) {
    return { updated: [], unresolved };
  }

  try {
    await instance.setFormFieldValues(valuesToWrite);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    for (const name of accepted) {
      unresolved.push({ name, reason });
    }
    return { updated: [], unresolved };
  }

  // Read the post-write value map and project the accepted entries through
  // it. setFormFieldValues resolves once committed, so the snapshot here is
  // authoritative.
  const postValues = instance.getFormFieldValues();
  const updatedWithValues = accepted.map((name) => ({
    name,
    value: (postValues[name] ?? null) as string | string[] | null
  }));

  return { updated: updatedWithValues, unresolved };
}

// ---------------------------------------------------------------------------
// Internal helpers — not exported. Tests hit them via updateFormFieldValues.
// ---------------------------------------------------------------------------

/**
 * Returns either a wrapper `{ value: <normalized> }` or an error string.
 * Wrapping the success in an object lets `null` and `""` pass through cleanly
 * (a returned `null` would otherwise be ambiguous with "no value supplied").
 */
function normalizeValue(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  field: any,
  value: string | string[] | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FF: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ImmutableList: any
): { value: unknown } | string {
  if (field instanceof FF.CheckBoxFormField || field instanceof FF.ChoiceFormField) {
    if (value === null) return { value: ImmutableList() };
    if (Array.isArray(value)) return { value: ImmutableList(value) };
    if (typeof value === "string") return { value: ImmutableList([value]) };
    return `Invalid value type for ${
      field instanceof FF.CheckBoxFormField ? "checkbox" : "choice"
    } field: expected string, string[], or null`;
  }
  if (field instanceof FF.RadioButtonFormField) {
    if (value === null) return { value: null };
    if (typeof value === "string") return { value };
    return "Radio field expects a string option name or null to deselect";
  }
  if (field instanceof FF.TextFormField) {
    if (value === null) return { value: "" };
    if (typeof value === "string") return { value };
    return "Text field expects a string or null";
  }
  // Unknown field types fall through; let the SDK's validator reject them.
  return { value };
}

/**
 * Per-type form-field value validator. Returns null on success or a
 * model-readable error string. The SDK's own validator isn't exported from
 * `@nutrient-sdk/viewer`, but its three branches (text=string,
 * radio=string|null, choice/checkbox=Immutable.List) are stable across SDK
 * versions.
 */
function validateFormFieldValue(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  field: any,
  value: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FF: any
): string | null {
  if (field instanceof FF.TextFormField) {
    return typeof value === "string"
      ? null
      : `Text field requires a string, got ${describeType(value)}`;
  }
  if (field instanceof FF.CheckBoxFormField || field instanceof FF.ChoiceFormField) {
    // Duck-type the Immutable.List via .toArray() — we don't import the
    // Immutable type directly, only its handle off the runtime SDK object.
    const looksLikeList =
      value != null && typeof (value as { toArray?: unknown }).toArray === "function";
    return looksLikeList
      ? null
      : `Checkbox/choice field requires a list of strings, got ${describeType(value)}`;
  }
  if (field instanceof FF.RadioButtonFormField) {
    return value === null || typeof value === "string"
      ? null
      : `Radio field requires a string or null, got ${describeType(value)}`;
  }
  return null;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
