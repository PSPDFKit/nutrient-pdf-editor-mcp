---
name: nutrient-salesforce-docgen
description: Generate a document from a Nutrient template for a Salesforce record and show it to the user in the Nutrient viewer. Use when the user asks to "generate", "create" or "make" a document, quote, letter, contract or report "with Nutrient" or "from template X" for a Salesforce record (Opportunity, Account, Contact, case, etc.).
---

# Nutrient document generation from Salesforce

Two connectors work together:

- **Salesforce** (the user's Salesforce MCP connector). It exposes the Nutrient actions
  `Nutrient: List Templates` and `Nutrient: Generate Document`.
- **Nutrient Document Viewer** (this plugin's connector). Its `open_document_url` tool shows a
  document inside the chat.

## Workflow

1. **Find the record.** If the user named a record ("the Acme renewal opportunity"), look up its Id
   with the Salesforce connector (query or search). Confirm with the user when several match.
2. **Pick the template.** If the user did not give an exact template, call
   `Nutrient: List Templates` with `salesforceObject` set to the record's object API name
   (for example `Opportunity`). Choose the matching template, or ask the user when unclear.
3. **Generate.** Call `Nutrient: Generate Document` with:
   - `recordId`: the record Id
   - `templateId` (preferred) or `templateName`
   - `outputFormat`: `PDF` unless the user asks for Word/DOCX
   - leave `createViewerLink` at its default (true)
4. **Check the result.** If `success` is false, tell the user `errorMessage` in plain words and stop.
   If `warning` mentions the viewer link, the file was still saved to the record: say so and give
   the file name instead of opening it.
5. **Open it.** Call the Nutrient viewer's `open_document_url` with `url` = `viewerUrl` and
   `fileName` = `fileName` from the result. Pass the URL exactly as returned.
   If the Salesforce tool returned the action's outputs under different labels, `viewerUrl` is the
   "Viewer Download URL" output.
6. **Tell the user** in one or two sentences: the document was generated from template X for
   record Y, it is saved to the record's Files, and it is open in the viewer.

## After it is open

- Use the viewer tools (`read_text`, `search_exact_text`, `create_annotation`,
  `update_form_field_values`, `apply_annotations`, ...) when the user asks to review, mark up,
  fill or redact the document.
- Edits stay in the viewer for this conversation. They are not saved back to Salesforce. If the
  user wants a changed version in Salesforce, regenerate from the template after the data is
  updated, or tell them to download it from the viewer toolbar.

## Rules

- Never paste the download URL into the chat; it is a short-lived public link to the file.
- Do not download the file yourself or read it through Salesforce to show it. Use
  `open_document_url`.
- Do not call `Nutrient: Generate Document` again just to reopen the same document. If the viewer
  link expired, regenerating creates a new file on the record, so ask first.
