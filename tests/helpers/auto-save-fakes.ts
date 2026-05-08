import type { NutrientInstanceLike } from "../../src/viewer/auto-save.js";
import type { ChunkedWriteSink } from "../../src/viewer/document-save.js";

export interface FakeInstance extends NutrientInstanceLike {
  fire(event: { hasUnsavedChanges: boolean }): void;
  setUnsaved(b: boolean): void;
  setExportPDFDelay(ms: number): void;
  exportPDFCalls(): number;
  listenerCount(): number;
}

export function makeInstance(): FakeInstance {
  let listeners: Array<(e: { hasUnsavedChanges: boolean }) => void> = [];
  let unsaved = false;
  let exportCount = 0;
  let exportDelay = 0;
  const exportedBytes = new TextEncoder().encode("PDF-CONTENT").buffer;

  return {
    addEventListener(_evt, h) {
      listeners.push(h);
    },
    removeEventListener(_evt, h) {
      listeners = listeners.filter((x) => x !== h);
    },
    hasUnsavedChanges() {
      return unsaved;
    },
    async exportPDF() {
      exportCount++;
      if (exportDelay > 0) {
        await new Promise<void>((r) => setTimeout(r, exportDelay));
      }
      return exportedBytes.slice(0);
    },
    fire(event) {
      for (const l of [...listeners]) l(event);
    },
    setUnsaved(b) {
      unsaved = b;
    },
    setExportPDFDelay(ms) {
      exportDelay = ms;
    },
    exportPDFCalls() {
      return exportCount;
    },
    listenerCount() {
      return listeners.length;
    }
  };
}

export interface SinkSpy {
  sink: ChunkedWriteSink;
  callCount(): number;
  calls(): Array<{ name: string; arguments: Record<string, unknown> }>;
  setError(msg: string | null): void;
}

export function makeSink(): SinkSpy {
  const recorded: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let errMsg: string | null = null;
  return {
    sink: {
      async callServerTool(args) {
        recorded.push(args);
        if (errMsg !== null) {
          return { isError: true, content: [{ type: "text", text: errMsg }] };
        }
        return { structuredContent: { finalized: true } };
      }
    },
    callCount: () => recorded.length,
    calls: () => recorded,
    setError: (m) => {
      errMsg = m;
    }
  };
}
