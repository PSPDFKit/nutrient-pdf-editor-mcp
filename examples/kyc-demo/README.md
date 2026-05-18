# KYC demo bundle

A self-contained example that drives Nutrient PDF Editor through a
complete corporate-customer KYC packet — designed for a 60–90s
marketing video, but runnable any time end-to-end.

The agent (Claude in Cowork, with this connector installed) performs
the full loop: extract entity + beneficial owners from two source
PDFs → fill the FinCEN CDD certification form → run a mock OFAC
screening → apply a compliance approval stamp.

All entity data is fictional (`Acme Industries Holdings, Ltd.`).
The PDFs are committed binaries — re-running the demo will mutate
`forms/03_fincen_cdd_blank.pdf` in place; reset with `git checkout`
(see ["Resetting between takes"](#resetting-between-takes) below).

## Bundle layout

```
examples/kyc-demo/
├── README.md                        ← you are here
├── inputs/                          ← what the customer "submits"
│   ├── 01_certificate_of_incorporation.pdf
│   └── 02_ubo_declaration.pdf
├── forms/                           ← what Claude fills
│   └── 03_fincen_cdd_blank.pdf      (AcroForm fillable fields)
└── prompts/
    ├── user_prompt.md               ← paste this into Claude
    └── skill_kyc_rules.md           ← firm-specific KYC policy
```

## Prerequisites

- Nutrient PDF Editor `.mcpb` installed in Claude Desktop. See
  [`docs/distribution/claude-connector.md`](../../docs/distribution/claude-connector.md)
  for the install path.
- Claude Desktop with **Cowork** enabled (this is the only surface
  where the embedded viewer renders).

## Running the demo

1. **Open Claude Desktop** in a Cowork chat.
2. **Make this folder discoverable** as an MCP root. The simplest
   path: open the folder in Claude Desktop's connector settings, or
   start your chat with the working directory set to the repo root
   so `examples/kyc-demo/...` resolves cleanly.
3. **Paste the prompt:** copy the contents of
   [`prompts/user_prompt.md`](prompts/user_prompt.md) verbatim and
   send it.
4. The agent applies the approval stamp on the FinCEN CDD signature
   block and announces completion. The demo runs hands-free — no
   on-camera operator click needed.

Expected end-to-end runtime: **~60–80 seconds** on a typical
Apple Silicon Mac.

## Resetting between takes

Each run mutates `forms/03_fincen_cdd_blank.pdf` in place (form fills
+ annotations). To restore the pristine blank between video takes,
discard the working-tree changes:

```bash
git checkout -- examples/kyc-demo/forms/ examples/kyc-demo/inputs/
```

The `inputs/` source PDFs are read-only in normal use, but listing
them defends against any accidental write.

## Tool-call sequence (for QA)

The agent should walk roughly this path. If it deviates, the demo
likely won't read well on camera:

```
1.  open_document(inputs/01_certificate_of_incorporation.pdf)
2.  read_text                                  → entity facts
3.  open_document(inputs/02_ubo_declaration.pdf)  ← in-place SDK swap
4.  read_text                                  → BO list, owners, %
       (apply 25% rule from kyc-rules; option pool drops out)
5.  [text-only]: state OFAC mock = "No match"
6.  open_document(forms/03_fincen_cdd_blank.pdf)
7.  read_form_fields                           → 25 named text fields
8.  update_form_field_values({ … all 25 … })
9.  create_annotation                          ← "APPROVED — Sarah Lin
                                                  · 2026-05-07" stamp
                                                  on Section V
10. (auto-save flushes via the iframe write loop — no explicit call)
```

## Customizing for another institution

The bundle is structured so the only file that changes between firms
is [`prompts/skill_kyc_rules.md`](prompts/skill_kyc_rules.md). Swap
in your own threshold rule, sanctions list, or stamp format and the
demo adapts.

To re-skin the entity (different fictional company, different BO
identities), edit the PDFs directly with any PDF editor. The 25
form-field names on `03_fincen_cdd_blank.pdf` (see the table below)
must stay stable — the `kyc-rules` skill references them by name.

## Field reference

The 25 fillable fields on `03_fincen_cdd_blank.pdf`:

| Field name | Maps to (from sources) |
|---|---|
| `entity_legal_name` | Cert of Incorp `FIRST.` |
| `entity_type` | UBO Section A |
| `entity_address` | UBO Section A (Principal Office) |
| `entity_ein` | UBO Section A |
| `entity_state_file_no` | Cert of Incorp filing block |
| `bo1_name` | UBO Section B #1 |
| `bo1_dob` | UBO Section B #1 |
| `bo1_address` | UBO Section B #1 |
| `bo1_ssn` | UBO Section B #1 |
| `bo1_id_type` | UBO Section B #1 |
| `bo1_ownership_pct` | UBO Section B #1 (55%) |
| `bo2_name` | UBO Section B #2 |
| `bo2_dob` | UBO Section B #2 |
| `bo2_address` | UBO Section B #2 |
| `bo2_ssn` | UBO Section B #2 |
| `bo2_id_type` | UBO Section B #2 |
| `bo2_ownership_pct` | UBO Section B #2 (30%) |
| `cp_name`, `cp_title`, `cp_dob`, `cp_ssn`, `cp_address` | UBO Section B #1 (control person = CEO) |
| `certifier_name`, `certifier_title`, `certifier_date` | The compliance officer running the demo |

## Disclaimers

- Every identifier (SSN, EIN, file number, passport number, address)
  is fictional and chosen so as not to collide with real records.
- The OFAC sanctions step is mocked — this demo does not contact any
  real sanctions API.
- The CDD form layout is structured to mirror FinCEN Appendix A but
  is not a regulatory submission and should not be filed as one.
