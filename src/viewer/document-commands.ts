/**
 * Pure functions for document-level viewer commands.
 *
 * Extracted from src/viewer/main.ts: these functions implement the
 * read-only document and view-state commands. They receive the SDK instance
 * and relevant inputs as parameters, return a result object (or throw on
 * unexpected errors), and have no side effects beyond calling SDK APIs.
 *
 * The command-dispatch wrappers in main.ts call these, check for errors,
 * and call submit() with the appropriate payload.
 *
 * IMPORTANT: Do not import node:* — this file is part of the browser bundle.
 */

type ViewerInstance = import("@nutrient-sdk/viewer").Instance;

// Character-count cap for read_text.
// UTF-16 code unit length, not byte length — matching the JS string .length
// property. For typical document text (mostly ASCII/Latin) this is close to
// the byte count, but CJK or emoji-heavy text may consume more bytes in a
// UTF-8 encoding. The 100 K limit is intentionally generous to accommodate
// both; adjust if MCP host context-window constraints change.
export const READ_TEXT_CAP_CHARS = 100_000;

// -------------------------------------------------------------------------
// get_view_state / set_view_state
// -------------------------------------------------------------------------

export interface ViewStateResult {
  documentPath: string;
  pageCount: number;
  activePage: number;
  selection: undefined;
}

export function getViewStateData(
  instance: ViewerInstance,
  currentDocumentPath: string | null
): ViewStateResult {
  const currentPageIndex = instance.viewState.currentPageIndex;
  const pageCount = instance.totalPageCount ?? 0;
  return {
    documentPath: currentDocumentPath ?? "",
    pageCount: Number(pageCount),
    activePage: Number(currentPageIndex),
    selection: undefined
  };
}

export interface SetViewStateInput {
  activePage?: number;
  scrollTo?: {
    pageIndex: number;
    rect: { left: number; top: number; width: number; height: number };
  };
  selection?: unknown;
}

export type SetViewStateResult =
  | { ok: true; state: ViewStateResult }
  | { ok: false; error: string };

export function applySetViewState(
  instance: ViewerInstance,
  cmd: SetViewStateInput,
  currentDocumentPath: string | null
): SetViewStateResult {
  const pageCount = Number(instance.totalPageCount ?? 0);

  if (cmd.activePage != null) {
    if (cmd.activePage < 0 || cmd.activePage >= pageCount) {
      return {
        ok: false,
        error: `Invalid activePage: ${cmd.activePage}, valid range is 0-${pageCount - 1}`
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instance.setViewState((state: any) => state.set("currentPageIndex", cmd.activePage));
  }

  if (cmd.scrollTo) {
    const { pageIndex, rect } = cmd.scrollTo;
    if (pageIndex < 0 || pageIndex >= pageCount) {
      return {
        ok: false,
        error: `Invalid scrollTo.pageIndex: ${pageIndex}, valid range is 0-${pageCount - 1}`
      };
    }
    // SDK accepts a plain object at runtime even though the typings demand
    // an SDK Rect instance; we don't have access to the SDK namespace here
    // (only the Instance), so the cast is the pragmatic shim.
    instance.jumpToRect(pageIndex, {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    } as Parameters<ViewerInstance["jumpToRect"]>[1]);
  }

  const state = getViewStateData(instance, currentDocumentPath);
  return { ok: true, state };
}

// -------------------------------------------------------------------------
// search_exact_text
// -------------------------------------------------------------------------

export interface SearchHit {
  hitId: string;
  pageIndex: number;
  rect: { left: number; top: number; width: number; height: number };
  snippet: string;
}

export interface SearchResult {
  hits: SearchHit[];
}

export async function searchExact(
  instance: ViewerInstance,
  query: string,
  requestId: string,
  pageIndex?: number
): Promise<SearchResult | { error: string }> {
  const pageCount = Number(instance.totalPageCount ?? 0);

  if (pageIndex != null) {
    if (pageIndex < 0 || pageIndex >= pageCount) {
      return { error: `pageIndex out of range: ${pageIndex} (pageCount=${pageCount})` };
    }
  }

  const searchOptions =
    pageIndex != null ? { startPageIndex: pageIndex, endPageIndex: pageIndex } : undefined;

  const results = await instance.search(query, searchOptions);
  const hits: SearchHit[] = results
    .toArray()
    .map((h, i): SearchHit | null => {
      // `.first()` typing widens to `{}` because the generic notSetValue
      // parameter defaults to `unknown`; index into the array form instead.
      const [firstRect] = h.rectsOnPage.toArray();
      if (!firstRect) return null;
      return {
        hitId: `hit-${requestId}-${i}`,
        pageIndex: Number(h.pageIndex),
        rect: {
          left: Number(firstRect.left),
          top: Number(firstRect.top),
          width: Number(firstRect.width),
          height: Number(firstRect.height)
        },
        snippet: h.previewText ?? ""
      };
    })
    .filter((hit): hit is SearchHit => hit !== null);

  return { hits };
}

// -------------------------------------------------------------------------
// read_document_information
// -------------------------------------------------------------------------

export interface DocumentPermissions {
  annotationsAndForms: boolean;
  assemble: boolean;
  extract: boolean;
  extractAccessibility: boolean;
  fillForms: boolean;
  modification: boolean;
  printHighQuality: boolean;
  printing: boolean;
}

export interface DocumentInformationResult {
  pageCount: number;
  title?: string;
  permissions: DocumentPermissions;
}

export async function readDocumentInfo(
  instance: ViewerInstance
): Promise<DocumentInformationResult> {
  const pageCount = Number(instance.totalPageCount ?? 0);
  const title = instance.documentInfo?.title;
  const permissions = await instance.getDocumentPermissions();
  return {
    pageCount,
    ...(title !== undefined && { title }),
    permissions: {
      annotationsAndForms: Boolean(permissions.annotationsAndForms),
      assemble: Boolean(permissions.assemble),
      extract: Boolean(permissions.extract),
      extractAccessibility: Boolean(permissions.extractAccessibility),
      fillForms: Boolean(permissions.fillForms),
      modification: Boolean(permissions.modification),
      printHighQuality: Boolean(permissions.printHighQuality),
      printing: Boolean(permissions.printing)
    }
  };
}

// -------------------------------------------------------------------------
// read_page_info
// -------------------------------------------------------------------------

export interface PageInfoResult {
  width: number;
  height: number;
  rotation: number;
}

export function readPageInfo(
  instance: ViewerInstance,
  pageIndex: number
): { ok: true; info: PageInfoResult } | { ok: false; error: string } {
  const pageCount = Number(instance.totalPageCount ?? 0);
  if (pageIndex < 0 || pageIndex >= pageCount) {
    return { ok: false, error: `Page index ${pageIndex} out of range` };
  }
  const pageInfo = instance.pageInfoForIndex(pageIndex);
  if (!pageInfo) {
    return { ok: false, error: `Page index ${pageIndex} returned no info` };
  }
  return {
    ok: true,
    info: {
      width: Number(pageInfo.width),
      height: Number(pageInfo.height),
      rotation: Number(pageInfo.rotation)
    }
  };
}

// -------------------------------------------------------------------------
// read_text
// -------------------------------------------------------------------------

export interface ReadTextResult {
  text: string;
  pageCount: number;
  firstPage: number;
  lastPage: number;
  extractedPages: number;
  truncated: boolean;
  nextPageStart: number | null;
}

export async function readTextPages(
  instance: ViewerInstance,
  pageStart: number,
  pageEnd: number
): Promise<ReadTextResult | { error: string }> {
  const pageCount = Number(instance.totalPageCount ?? 0);
  const firstPage = pageStart;
  const lastRequestedPage = pageEnd === -1 ? pageCount - 1 : pageEnd;

  if (firstPage >= pageCount) {
    return {
      error: `Invalid page range: pageStart=${firstPage} is out of range (pageCount=${pageCount})`
    };
  }
  if (lastRequestedPage >= pageCount) {
    return {
      error: `Invalid page range: pageEnd=${lastRequestedPage} is out of range (pageCount=${pageCount})`
    };
  }
  if (firstPage > lastRequestedPage) {
    return {
      error: `Invalid page range: pageStart=${firstPage} > pageEnd=${lastRequestedPage}`
    };
  }

  const PAGE_DELIMITER_PREFIX = "\n\n=== PAGE ";
  const PAGE_DELIMITER_SUFFIX = " ===\n\n";

  const pageTexts: string[] = [];
  let runningLength = 0;
  let lastIncludedPage = firstPage - 1;
  let truncated = false;

  for (let p = firstPage; p <= lastRequestedPage; p++) {
    const lines = await instance.textLinesForPageIndex(p);
    const lineArray: Array<{ contents: string }> =
      typeof lines.toArray === "function"
        ? lines.toArray()
        : Array.from(lines as Iterable<{ contents: string }>);
    const pageText = lineArray.map((l) => l.contents ?? "").join("");
    const delimiter = `${PAGE_DELIMITER_PREFIX}${p}${PAGE_DELIMITER_SUFFIX}`;
    const segment = delimiter + pageText;
    const candidateLength = runningLength + segment.length;

    if (candidateLength > READ_TEXT_CAP_CHARS && lastIncludedPage >= firstPage) {
      truncated = true;
      break;
    }

    pageTexts.push(segment);
    runningLength += segment.length;
    lastIncludedPage = p;

    if (p === lastRequestedPage) break;
  }

  // Edge case: if no page was included yet (firstPage alone exceeded cap),
  // include it anyway — pages are the atomic unit.
  if (lastIncludedPage < firstPage) {
    const lines = await instance.textLinesForPageIndex(firstPage);
    const lineArray: Array<{ contents: string }> =
      typeof lines.toArray === "function"
        ? lines.toArray()
        : Array.from(lines as Iterable<{ contents: string }>);
    const pageText = lineArray.map((l) => l.contents ?? "").join("");
    const delimiter = `${PAGE_DELIMITER_PREFIX}${firstPage}${PAGE_DELIMITER_SUFFIX}`;
    pageTexts.push(delimiter + pageText);
    lastIncludedPage = firstPage;
    truncated = firstPage < lastRequestedPage;
  }

  const text = pageTexts.join("");
  const nextPageStart = truncated ? lastIncludedPage + 1 : null;

  return {
    text,
    pageCount,
    firstPage,
    lastPage: lastIncludedPage,
    extractedPages: lastIncludedPage - firstPage + 1,
    truncated,
    nextPageStart
  };
}
