# Nutrient PDF Editor

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-server-orange)](https://modelcontextprotocol.io)

![Nutrient PDF Editor demo](assets/demo.gif)

**A real PDF editor, right inside your Claude conversation.** Open a document and ask Claude to mark it up, fill it in, or redact what shouldn't be there — you see every change as it happens, and the edited file saves straight back to your machine.

Powered by the Nutrient Web Viewer, packaged as a Claude Connector for Claude Cowork.

- **What can Claude do with my PDFs?** — Open, read, annotate, fill forms, redact, and search — across 17 tools spanning the most common edit and review workflows.
- **Do I see the document?** — Yes. The full Nutrient Web Viewer renders inline in your chat. You and Claude share the same view, so when Claude points at page 4 you can see exactly what it means.
- **Where do my PDFs go?** — They stay on your machine. The viewer runs locally and your document bytes never leave the local process. ([trust & telemetry](#trust-and-telemetry))
- **What does it cost?** — Free to use inside Claude Cowork. The underlying Nutrient Web Viewer is licensed for Claude Cowork only; for any other installation, contact [sales@nutrient.io](mailto:sales@nutrient.io).

## Install

Search for Nutrient directly in the Claude Connector directory.

## Usage

Once it's installed, just describe what you want and Claude picks the right tools. You can use the Nutrient PDF Editor in Claude to:

- **Open and read** — *"Open `quarterly-report.pdf` and summarise pages 4–9."*
- **Annotate** — *"Highlight every mention of revenue on page 12 in yellow."*
- **Fill forms** — *"Fill in the W-9 with the values in `taxinfo.json`, then save it as `w9-filled.pdf`."*
- **Redact** — *"Find all SSNs in this contract, mark them for redaction, and apply once I confirm."*

Edit directly in the viewer or ask Claude to do it — either way, auto-save is on by default and changes go straight back to the original file.

## Trust and Telemetry

- **Licensing.** The Connector code in this repo is free to use and MIT-licensed (see [`LICENSE`](LICENSE)). The underlying Nutrient Web Viewer is licensed for use only within Claude Cowork; for any other installation, contact [sales@nutrient.io](mailto:sales@nutrient.io).
- **Documents stay local.** PDFs are read and written on your machine. The embedded viewer loads SDK assets from `cdn.cloud.nutrient.io`, but document bytes never leave the local process.
- **Telemetry is aggregate and not user-attributable.** The embedded SDK reports tool-call counts and outcome categories (success / failure / unsupported format) under a single shared license key baked into every install, so individual users are indistinguishable in the aggregate. The metrics payload does not include document contents, file names, file paths, or personally identifiable information.
- **Privacy policy.** Full disclosure in the [Privacy Policy](#privacy-policy) section below; Nutrient's general policy is at [https://www.nutrient.io/legal/privacy/](https://www.nutrient.io/legal/privacy/).

If you feed extracted text or annotations back into Claude or another model provider, **their** data policies apply.

## FAQ

### What does this give me that vanilla Claude doesn't?

A real PDF rendering surface and a tool surface that lets the model commit edits. Without it, agents work blind on PDFs — they parse text, but they can't *see* the document, can't draw annotations on it, can't fill form fields, and can't apply redactions. With it, you and the agent share the same view of the document, and the agent's edits land on disk.

### Do my documents leave my machine?

No. The MCP server runs locally and the viewer renders in-process. Nutrient does not receive your PDFs. SDK code is fetched from Nutrient's CDN at viewer-load time, but document bytes stay local.

### Do I need a license key or API token?

No — not for use inside Claude Cowork. The Connector is free to use and MIT-licensed; the embedded Nutrient Web Viewer it loads is licensed for use only within Claude Cowork. For any other installation, contact [sales@nutrient.io](mailto:sales@nutrient.io).

### What is collected?

Aggregate document and tool usage — *that a document was opened* and *that you used `apply_annotations`*, not *what was in it* or *what you redacted*. No document content, no file names or paths, no form field values, no PII, no IPs.

### Why is the Nutrient Web Viewer closed-source?

The MCP server, the bridge protocol, the tool definitions, and the viewer glue in this repo are MIT-licensed and reviewable. The underlying Nutrient Web Viewer that does the actual PDF rendering is loaded from Nutrient's CDN as a signed asset — closed-source, but the only thing it ever sees is your local document.

### Where can I report bugs or request tools?

[Open an issue](https://github.com/PSPDFKit/nutrient-pdf-editor-mcp/issues).

## Privacy Policy

The full Nutrient privacy policy is at **<https://www.nutrient.io/legal/privacy/>**. The disclosures below are specific to this MCP server and supplement that policy.

### Data collection

This MCP server is a **local process** — it runs on your machine and never opens a connection to Nutrient servers on its own. The only outbound network activity is:

- **SDK asset fetch**: The Nutrient Web Viewer is loaded from `cdn.cloud.nutrient.io` at viewer-start time. Nutrient's CDN receives the standard HTTP request metadata (IP address, user-agent, timestamp). No document data is sent.
- **Anonymous usage metrics**: The embedded SDK reports aggregate tool-call counts and outcome categories (success / failure / unsupported format) under a single shared license key. All installations share this key, so individual users are indistinguishable in the aggregate.

The MCP server does **not** collect, transmit, or store: document contents, file names, file paths, annotation content, form field values, or any personally identifiable information.

### Usage and storage

Document bytes are read from and written to paths that the MCP host (Claude) advertises via `roots/list`. All processing happens in-process on your machine. No document data is sent to Nutrient or any third party.

### Third-party sharing

No document content, file paths, file names, annotation data, form-field values, or other PII is shared with any third party. The only third-party touchpoint is Nutrient's CDN at `cdn.cloud.nutrient.io`, which serves the Web Viewer SDK assets at viewer-start time. The CDN receives only standard HTTP request metadata (IP address, user-agent, timestamp) — no document data ever crosses that boundary.

### Data retention

This MCP server retains nothing about your documents. No document content, file paths, file names, annotation values, form-field values, or PII is stored, cached, or persisted by the server. Aggregate, anonymous usage metrics (tool-call counts and outcome categories) are reported under a single shared license key and retained per the retention period stated in Nutrient's general privacy policy at <https://www.nutrient.io/legal/privacy/>.

### Contact

For questions, security reports, or concerns about this connector specifically, email **<ai-team@nutrient.io>** or [open an issue](https://github.com/PSPDFKit/nutrient-pdf-editor-mcp/issues). For questions about Nutrient's general privacy practices, see <https://www.nutrient.io/legal/privacy/>.

