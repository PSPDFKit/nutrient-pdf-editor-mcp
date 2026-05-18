import { describe, it, expect } from "vitest";
import { updateAnnotation, deleteAnnotation } from "../../src/viewer/annotation-operations.js";

describe("annotation-operations: pure functions for update and delete", () => {
  /**
   * Mock NutrientSDK with minimal implementations of Geometry.Rect and Immutable.List
   */
  const createMockSDK = () => ({
    Geometry: {
      Rect: class MockRect {
        left: number;
        top: number;
        width: number;
        height: number;

        constructor(obj: any) {
          this.left = obj.left;
          this.top = obj.top;
          this.width = obj.width;
          this.height = obj.height;
        }
      }
    },
    Immutable: {
      List: (items: any[]) => ({
        __isList: true,
        items
      })
    }
  });

  /**
   * Mock annotation with immutable-like interface
   */
  const createMockAnnotation = (id: string, overrides: any = {}) => ({
    id,
    pageIndex: overrides.pageIndex ?? 0,
    boundingBox: overrides.boundingBox ?? { left: 10, top: 20, width: 100, height: 15 },
    ...overrides,
    set: function (k: string, v: any) {
      const copy = { ...this };
      copy[k] = v;
      copy.set = this.set.bind(copy);
      return copy;
    }
  });

  describe("updateAnnotation", () => {
    it("finds and updates annotation on correct page", async () => {
      const mockSDK = createMockSDK();
      const ann0a = createMockAnnotation("a");
      const ann1b = createMockAnnotation("b");
      const ann1c = createMockAnnotation("c");
      const ann2d = createMockAnnotation("d");

      let updateCalled = false;
      let updatedAnnotation: any = null;

      const instance = {
        totalPageCount: 3,
        async getAnnotations(pageIndex: number) {
          if (pageIndex === 0) return {
            find: (pred: any) => (pred(ann0a) ? ann0a : undefined)
          };
          if (pageIndex === 1) return {
            find: (pred: any) => (pred(ann1b) ? ann1b : pred(ann1c) ? ann1c : undefined)
          };
          if (pageIndex === 2) return {
            find: (pred: any) => (pred(ann2d) ? ann2d : undefined)
          };
          return { find: () => undefined };
        },
        async update(ann: any) {
          updateCalled = true;
          updatedAnnotation = ann;
        },
        async delete() {}
      };

      const result = await updateAnnotation(instance, "b", { boundingBox: { left: 50, top: 60, width: 200, height: 30 } }, mockSDK);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.id).toBe("b");
      }
      expect(updateCalled).toBe(true);
      expect(updatedAnnotation).toBeTruthy();
      expect(updatedAnnotation.boundingBox.left).toBe(50);
    });

    it("handles rects patch for markup annotations", async () => {
      const mockSDK = createMockSDK();
      const annWithRects: any = {
        id: "ann1",
        pageIndex: 0,
        rects: { __isList: true, items: [] },
        set: function (k: string, v: any) {
          const copy: any = { ...this };
          copy[k] = v;
          copy.set = this.set.bind(copy);
          return copy;
        }
      };

      let updatedAnnotation: any = null;

      const instance = {
        totalPageCount: 1,
        async getAnnotations(pageIndex: number) {
          if (pageIndex === 0) return {
            find: (pred: any) => (pred(annWithRects) ? annWithRects : undefined)
          };
          return { find: () => undefined };
        },
        async update(ann: any) {
          updatedAnnotation = ann;
        },
        async delete() {}
      };

      const patch = {
        rects: [
          { left: 10, top: 20, width: 100, height: 15 },
          { left: 120, top: 20, width: 100, height: 15 }
        ]
      };

      const result = await updateAnnotation(instance, "ann1", patch, mockSDK);

      expect(result.ok).toBe(true);
      expect(updatedAnnotation?.rects?.__isList).toBe(true);
      expect(updatedAnnotation?.rects?.items?.length).toBe(2);
    });

    it("returns error if annotation not found", async () => {
      const mockSDK = createMockSDK();
      const instance = {
        totalPageCount: 2,
        async getAnnotations() {
          return { find: () => undefined };
        },
        async update() {},
        async delete() {}
      };

      const result = await updateAnnotation(instance, "nonexistent", { text: "new text" }, mockSDK);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/not found/i);
      }
    });

    it("stops scan at first match (termination)", async () => {
      const mockSDK = createMockSDK();
      const ann0a = createMockAnnotation("dup-id");
      const ann1a = createMockAnnotation("dup-id");

      let pagesScanned = 0;

      const instance = {
        totalPageCount: 3,
        async getAnnotations(pageIndex: number) {
          pagesScanned++;
          if (pageIndex === 0) return {
            find: (pred: any) => (pred(ann0a) ? ann0a : undefined)
          };
          if (pageIndex === 1) return {
            find: (pred: any) => (pred(ann1a) ? ann1a : undefined)
          };
          return { find: () => undefined };
        },
        async update() {},
        async delete() {}
      };

      const result = await updateAnnotation(instance, "dup-id", {}, mockSDK);

      expect(result.ok).toBe(true);
      expect(pagesScanned).toBe(1); // Should stop after finding on page 0
    });
  });

  describe("deleteAnnotation", () => {
    it("finds, snapshots, and deletes annotation", async () => {
      // Pre-delete snapshot is captured via .toJSON() on the SDK instance.
      const ann1b = {
        ...createMockAnnotation("b"),
        toJSON: () => ({ id: "b", type: "pspdfkit/note", pageIndex: 1 })
      };

      let deleteCalled = false;
      let deleteId = "";

      const instance = {
        totalPageCount: 2,
        async getAnnotations(pageIndex: number) {
          if (pageIndex === 1)
            return {
              find: (pred: (a: unknown) => boolean) => (pred(ann1b) ? ann1b : undefined)
            };
          return { find: () => undefined };
        },
        async update() {},
        async delete(id: string) {
          deleteCalled = true;
          deleteId = id;
        }
      };

      const result = await deleteAnnotation(instance, "b");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.id).toBe("b");
        // Pre-delete snapshot is what the agent gets back so it knows what
        // it lost — the SDK class's .toJSON() output.
        expect(result.annotation).toEqual({ id: "b", type: "pspdfkit/note", pageIndex: 1 });
      }
      expect(deleteCalled).toBe(true);
      expect(deleteId).toBe("b");
    });

    it("returns null annotation when the SDK class lacks toJSON", async () => {
      // Older test mocks (and edge-case classes) don't expose toJSON; the
      // viewer falls back to null rather than throwing.
      const ann = createMockAnnotation("legacy");
      const instance = {
        totalPageCount: 1,
        async getAnnotations() {
          return {
            find: (pred: (a: unknown) => boolean) => (pred(ann) ? ann : undefined)
          };
        },
        async update() {},
        async delete() {}
      };
      const result = await deleteAnnotation(instance, "legacy");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.annotation).toBeNull();
    });

    it("returns error if annotation not found", async () => {
      const instance = {
        totalPageCount: 2,
        async getAnnotations() {
          return { find: () => undefined };
        },
        async update() {},
        async delete() {}
      };

      const result = await deleteAnnotation(instance, "nonexistent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/not found/i);
      }
    });

    it("stops scan at first match", async () => {
      const ann0a = createMockAnnotation("dup-id");
      const ann1a = createMockAnnotation("dup-id");

      let pagesScanned = 0;

      const instance = {
        totalPageCount: 3,
        async getAnnotations(pageIndex: number) {
          pagesScanned++;
          if (pageIndex === 0)
            return {
              find: (pred: (a: unknown) => boolean) => (pred(ann0a) ? ann0a : undefined)
            };
          if (pageIndex === 1)
            return {
              find: (pred: (a: unknown) => boolean) => (pred(ann1a) ? ann1a : undefined)
            };
          return { find: () => undefined };
        },
        async update() {},
        async delete() {}
      };

      const result = await deleteAnnotation(instance, "dup-id");

      expect(result.ok).toBe(true);
      expect(pagesScanned).toBe(1); // Should stop after finding on page 0
    });
  });
});
