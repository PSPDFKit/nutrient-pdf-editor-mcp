import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/e2e/harness/fixtures.ts → projectRoot is three levels up.
const projectRoot = path.resolve(__dirname, "../../..");

export const FIXTURES_DIR = path.join(projectRoot, "tests/fixtures");
export const SAMPLE_PDFS_DIR = path.join(projectRoot, "tests/fixtures/sample-pdfs");

export const SAMPLE_PDF = path.join(FIXTURES_DIR, "sample.pdf");
export const SAMPLE_2_PDF = path.join(FIXTURES_DIR, "sample-2.pdf");
export const FORM_EXAMPLE_PDF = path.join(FIXTURES_DIR, "form_example.pdf");

// Real-world-shaped PDFs. Used wherever the test needs production-shaped
// input (multi-page, real AcroForm, real text content for redaction
// round-trips).
export const SIGN_OFF_PDF = path.join(SAMPLE_PDFS_DIR, "human-resources-form.pdf");
export const CLA_PDF = path.join(SAMPLE_PDFS_DIR, "microsoft-cla.pdf");
export const UBER_10K_PDF = path.join(SAMPLE_PDFS_DIR, "uber-2021-form-10k.pdf");
export const PAPERS_PDF = path.join(
  SAMPLE_PDFS_DIR,
  "ten-simple-rules-for-structuring-papers.pdf"
);
export const HR_LETTER_PDF = path.join(SAMPLE_PDFS_DIR, "hr-separation-letter.pdf");

/**
 * Roots advertised to the server via `roots/list`. Includes both the
 * synthetic test-fixtures directory and the real-PDF sample directory so
 * any test can open from either without re-declaring its root list.
 */
export const FIXTURE_ROOTS = [FIXTURES_DIR, SAMPLE_PDFS_DIR];
