/**
 * Pure functions for annotation update and delete operations.
 *
 * Each function returns enough information for the model to know exactly what
 * changed: `updateAnnotation` returns the post-update InstantJSON; `deleteAnnotation`
 * returns the pre-delete InstantJSON of the annotation that was removed. This
 * lets the calling agent inspect "what is the state now?" without a follow-up
 * `read_annotations` call.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK boundary: no types available at runtime
type NutrientSDKType = any;

/**
 * Represents the viewer instance interface needed for annotation operations.
 * Allows tests to mock getAnnotations, update, and delete methods.
 */
export interface ViewerInstanceMock {
  totalPageCount: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK boundary
  getAnnotations(pageIndex: number): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK boundary
  update(annotation: any): Promise<unknown>;
  delete(id: string): Promise<unknown>;
}

/**
 * Result of annotation update operation.
 *
 * On success the `annotation` field carries the post-update InstantJSON shape
 * (or, if `.toJSON()` is unavailable on the SDK class for any reason, `null`).
 */
export type UpdateResult =
  | { ok: true; id: string; annotation: unknown | null }
  | { ok: false; error: string };

/**
 * Result of annotation delete operation. `annotation` is the pre-delete
 * InstantJSON snapshot — what the caller just lost.
 */
export type DeleteResult =
  | { ok: true; id: string; annotation: unknown | null }
  | { ok: false; error: string };

/**
 * Update an annotation by scanning all pages for the matching id, applying
 * the patch, and calling `instance.update()`. Returns the post-update
 * InstantJSON snapshot so the caller can see exactly which fields are now
 * what — including any defaulting the SDK applied.
 */
export async function updateAnnotation(
  instance: ViewerInstanceMock,
  id: string,
  patch: Record<string, unknown>,
  NutrientSDK: NutrientSDKType
): Promise<UpdateResult> {
  const pageCount = instance.totalPageCount;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let existing: any = null;
  for (let p = 0; p < pageCount && !existing; p++) {
    const pageAnns = await instance.getAnnotations(p);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const found = pageAnns.find((a: any) => a.id === id);
    if (found) existing = found;
  }

  if (!existing) {
    return { ok: false, error: `Annotation not found: ${id}` };
  }

  // Apply patch via .set() for each entry.
  let updated = existing;
  for (const [k, v] of Object.entries(patch)) {
    if (k === "rect" || k === "boundingBox") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rect = new NutrientSDK.Geometry.Rect(v as any);
      updated = updated.set("boundingBox", rect);
    } else if (k === "rects" && Array.isArray(v)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rects = (v as any[]).map((r) => new NutrientSDK.Geometry.Rect(r));
      updated = updated.set("rects", NutrientSDK.Immutable.List(rects));
    } else {
      updated = updated.set(k, v);
    }
  }

  try {
    // The SDK's `update` returns an array of the resolved Change objects;
    // we prefer that over `updated` since it reflects any SDK-side defaulting.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolved = (await instance.update(updated)) as Array<any> | undefined;
    const fresh = Array.isArray(resolved) && resolved.length > 0 ? resolved[0] : updated;
    return {
      ok: true,
      id,
      annotation: serializeAnnotationSafe(fresh)
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to update annotation: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

/**
 * Delete an annotation by scanning all pages for the matching id, snapshotting
 * its InstantJSON shape, and calling `instance.delete()`. The snapshot is the
 * pre-delete state — the caller's record of what was just removed.
 */
export async function deleteAnnotation(
  instance: ViewerInstanceMock,
  id: string
): Promise<DeleteResult> {
  const pageCount = instance.totalPageCount;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let target: any = null;
  for (let p = 0; p < pageCount && !target; p++) {
    const pageAnns = await instance.getAnnotations(p);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const found = pageAnns.find((a: any) => a.id === id);
    if (found) target = found;
  }

  if (!target) {
    return { ok: false, error: `Annotation not found: ${id}` };
  }

  const snapshot = serializeAnnotationSafe(target);

  try {
    await instance.delete(id);
    return { ok: true, id, annotation: snapshot };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to delete annotation: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

/**
 * Best-effort `.toJSON()` invocation. Returns null when the SDK class doesn't
 * expose `toJSON` (test mocks, edge-case classes), so callers always get a
 * predictable `unknown | null` and never a thrown exception.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeAnnotationSafe(annotation: any): unknown | null {
  if (annotation == null) return null;
  if (typeof annotation.toJSON !== "function") return null;
  try {
    return annotation.toJSON();
  } catch {
    return null;
  }
}

/**
 * Map from SDK class to annotation type string.
 * Uses `instanceof` against the SDK's exported class handles — `constructor.name`
 * is unreliable because the SDK's internal classes are already minified in its
 * UMD bundle (`HighlightAnnotation: () => y.ax`). Exported for testing.
 *
 * Extracted from src/viewer/main.ts to this module where it logically belongs.
 */
export function sdkClassToType(annotation: unknown, NutrientSDK: NutrientSDKType): string {
  if (annotation == null || NutrientSDK?.Annotations == null) return "unknown";
  const A = NutrientSDK.Annotations;
  if (annotation instanceof A.HighlightAnnotation) return "highlight";
  if (annotation instanceof A.NoteAnnotation) return "note";
  if (annotation instanceof A.TextAnnotation) return "text";
  if (annotation instanceof A.InkAnnotation) return "ink";
  if (annotation instanceof A.StrikeOutAnnotation) return "strikeout";
  if (annotation instanceof A.UnderlineAnnotation) return "underline";
  if (annotation instanceof A.SquiggleAnnotation) return "squiggly";
  if (annotation instanceof A.LinkAnnotation) return "link";
  if (annotation instanceof A.WidgetAnnotation) return "widget";
  if (annotation instanceof A.RedactionAnnotation) return "redaction";
  return "unknown";
}

/**
 * Compute a bounding box from an SDK annotation. Freshly-created annotations
 * may ship with a zero-sized `boundingBox` — in that case (or when the field
 * is unset) fall back to the union of `a.rects` (markup annotations) or
 * `a.rect` (rect-based annotations like notes/text).
 *
 * Extracted from src/viewer/main.ts to this module where it logically belongs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractRect(a: any): { left: number; top: number; width: number; height: number } {
  const bb = a?.boundingBox;
  if (bb && (Number(bb.width) > 0 || Number(bb.height) > 0)) {
    return {
      left: Number(bb.left),
      top: Number(bb.top),
      width: Number(bb.width),
      height: Number(bb.height)
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rects: any = a?.rects;
  const arr =
    typeof rects?.toArray === "function" ? rects.toArray() : Array.isArray(rects) ? rects : null;
  if (arr && arr.length > 0) {
    let l = Infinity,
      t = Infinity,
      r = -Infinity,
      b = -Infinity;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const rc of arr as any[]) {
      const left = Number(rc.left);
      const top = Number(rc.top);
      const w = Number(rc.width);
      const h = Number(rc.height);
      if (left < l) l = left;
      if (top < t) t = top;
      if (left + w > r) r = left + w;
      if (top + h > b) b = top + h;
    }
    return { left: l, top: t, width: r - l, height: b - t };
  }
  const single = a?.rect;
  if (single) {
    return {
      left: Number(single.left),
      top: Number(single.top),
      width: Number(single.width),
      height: Number(single.height)
    };
  }
  if (bb) {
    return {
      left: Number(bb.left),
      top: Number(bb.top),
      width: Number(bb.width),
      height: Number(bb.height)
    };
  }
  return { left: 0, top: 0, width: 0, height: 0 };
}
