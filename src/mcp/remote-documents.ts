import { randomUUID } from "node:crypto";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./logger.js";

/**
 * Remote documents: documents that are not on the local disk but are fetched
 * once from an HTTPS URL (for example the short-lived download link that the
 * Salesforce "Nutrient: Generate Document" action returns) and kept in memory.
 *
 * Identity: each remote document gets an opaque `documentPath` of the form
 * `remote-doc://<uuid>/<encoded file name>`. That string flows through the
 * existing viewer protocol unchanged (tool result → iframe → `?path=` on the
 * bytes resource → `documentPath` on save chunks), so the viewer needs no new
 * wire format. The uuid is unguessable, which is what scopes access.
 */
export const REMOTE_DOCUMENT_PREFIX = "remote-doc://";

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 60_000;

/** Host suffixes that may serve documents. Override with NUTRIENT_ALLOWED_DOWNLOAD_HOSTS. */
export const DEFAULT_ALLOWED_HOST_SUFFIXES = [
  "force.com",
  "salesforce.com",
  "cloudforce.com",
  "salesforce-sites.com",
  "documentforce.com"
];

export interface RemoteDocument {
  documentPath: string;
  fileName: string;
  sourceHost: string;
  bytes: Buffer;
  createdAt: number;
  updatedAt: number;
  /** Number of times the viewer saved edits back into this cache entry. */
  saveCount: number;
}

const documents = new Map<string, RemoteDocument>();
/** Staging buffers for chunked saves, keyed by `${documentPath}::${viewUUID}`. */
const staging = new Map<string, Buffer[]>();

export function isRemoteDocumentPath(documentPath: string | null | undefined): boolean {
  return typeof documentPath === "string" && documentPath.startsWith(REMOTE_DOCUMENT_PREFIX);
}

function ttlMs(): number {
  const raw = Number(process.env.NUTRIENT_REMOTE_DOC_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

export function maxRemoteBytes(): number {
  const raw = Number(process.env.NUTRIENT_REMOTE_DOC_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
}

export function allowedHostSuffixes(): string[] {
  const raw = process.env.NUTRIENT_ALLOWED_DOWNLOAD_HOSTS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw
      .split(",")
      .map((h) => h.trim().toLowerCase().replace(/^\*\./, ""))
      .filter((h) => h.length > 0);
  }
  return DEFAULT_ALLOWED_HOST_SUFFIXES;
}

/** Throws unless `raw` is an https URL on an allowed host. Returns the parsed URL. */
export function validateDownloadUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, "url is not a valid absolute URL.");
  }
  if (url.protocol !== "https:") {
    throw new McpError(ErrorCode.InvalidParams, "Only https:// download URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new McpError(ErrorCode.InvalidParams, "Download URLs must not contain credentials.");
  }
  const host = url.hostname.toLowerCase();
  const allowed = allowedHostSuffixes();
  if (
    !allowed.includes("*") &&
    !allowed.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  ) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Downloads from ${host} are not allowed. Allowed host suffixes: ${allowed.join(", ")}.`
    );
  }
  return url;
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : "document.pdf";
}

function fileNameFromHeaders(headers: Headers): string | null {
  const disposition = headers.get("content-disposition");
  if (!disposition) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  return plain?.[1]?.trim() ?? null;
}

/** Fetch with manual redirects so every hop is re-validated against the allowlist. */
async function fetchAllowed(start: URL): Promise<Response> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "*/*", "user-agent": "nutrient-viewer-mcp" }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      current = validateDownloadUrl(new URL(location, current).toString());
      continue;
    }
    return response;
  }
  throw new McpError(
    ErrorCode.InvalidRequest,
    "Too many redirects while downloading the document."
  );
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Document is too large (${declared} bytes, limit ${limit}).`
    );
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new McpError(ErrorCode.InvalidRequest, `Document is too large (limit ${limit} bytes).`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** True when the bytes look like an HTML page rather than a document (e.g. an expired-link page). */
function looksLikeHtml(bytes: Buffer, contentType: string | null): boolean {
  if (contentType && /text\/html/i.test(contentType)) return true;
  const head = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/** Download `rawUrl`, cache it, and return the cache entry. */
export async function fetchRemoteDocument(
  rawUrl: string,
  fileNameHint?: string
): Promise<RemoteDocument> {
  pruneRemoteDocuments();
  const url = validateDownloadUrl(rawUrl);
  let response: Response;
  try {
    response = await fetchAllowed(url);
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw new McpError(ErrorCode.InternalError, `Could not download the document: ${String(err)}`);
  }
  if (!response.ok) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Download failed with HTTP ${response.status}. The link may have expired; generate the document again to get a fresh link.`
    );
  }
  const bytes = await readLimited(response, maxRemoteBytes());
  if (bytes.length === 0) {
    throw new McpError(ErrorCode.InvalidRequest, "The download returned an empty file.");
  }
  if (looksLikeHtml(bytes, response.headers.get("content-type"))) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "The link returned a web page instead of a file. Use the direct download URL (ContentDownloadUrl), or generate a fresh link."
    );
  }
  const fileName = sanitizeFileName(
    fileNameHint ?? fileNameFromHeaders(response.headers) ?? "document.pdf"
  );
  const documentPath = `${REMOTE_DOCUMENT_PREFIX}${randomUUID()}/${encodeURIComponent(fileName)}`;
  const now = Date.now();
  const entry: RemoteDocument = {
    documentPath,
    fileName,
    sourceHost: url.hostname,
    bytes,
    createdAt: now,
    updatedAt: now,
    saveCount: 0
  };
  documents.set(documentPath, entry);
  log("info", "remote_document.fetched", { host: url.hostname, bytes: bytes.length, fileName });
  return entry;
}

export function getRemoteDocument(documentPath: string): RemoteDocument | null {
  const entry = documents.get(documentPath) ?? null;
  if (entry && Date.now() - entry.updatedAt > ttlMs()) {
    documents.delete(documentPath);
    return null;
  }
  return entry;
}

/** Append (or start, at offset 0) a chunked save from the viewer. */
export function writeRemoteChunk(
  documentPath: string,
  viewUUID: string,
  offset: number,
  chunk: Buffer
): number {
  const key = `${documentPath}::${viewUUID}`;
  if (offset === 0) staging.set(key, []);
  const parts = staging.get(key);
  if (!parts) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "No save in progress; first chunk must use offset=0."
    );
  }
  const size = parts.reduce((n, b) => n + b.length, 0);
  if (size !== offset) {
    staging.delete(key);
    throw new McpError(
      ErrorCode.InvalidParams,
      `Chunk offset ${offset} does not match staged size ${size}.`
    );
  }
  if (size + chunk.length > maxRemoteBytes()) {
    staging.delete(key);
    throw new McpError(ErrorCode.InvalidRequest, "Saved document exceeds the size limit.");
  }
  if (chunk.length > 0) parts.push(chunk);
  return size + chunk.length;
}

/** Commit a staged save into the cache entry. */
export function finalizeRemoteSave(documentPath: string, viewUUID: string): RemoteDocument {
  const key = `${documentPath}::${viewUUID}`;
  const parts = staging.get(key);
  staging.delete(key);
  const entry = getRemoteDocument(documentPath);
  if (!entry) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "This document is no longer available on the server. Open it again."
    );
  }
  if (!parts) {
    throw new McpError(ErrorCode.InvalidParams, "No save in progress for this document.");
  }
  entry.bytes = Buffer.concat(parts);
  entry.updatedAt = Date.now();
  entry.saveCount += 1;
  return entry;
}

export function pruneRemoteDocuments(): void {
  const cutoff = Date.now() - ttlMs();
  for (const [key, entry] of documents) {
    if (entry.updatedAt < cutoff) documents.delete(key);
  }
}

/** Test-only. */
export function __resetRemoteDocumentsForTesting(): void {
  documents.clear();
  staging.clear();
}

/** Test-only: insert an entry without a network fetch. */
export function __putRemoteDocumentForTesting(fileName: string, bytes: Buffer): RemoteDocument {
  const documentPath = `${REMOTE_DOCUMENT_PREFIX}${randomUUID()}/${encodeURIComponent(fileName)}`;
  const now = Date.now();
  const entry: RemoteDocument = {
    documentPath,
    fileName,
    sourceHost: "test.invalid",
    bytes,
    createdAt: now,
    updatedAt: now,
    saveCount: 0
  };
  documents.set(documentPath, entry);
  return entry;
}
