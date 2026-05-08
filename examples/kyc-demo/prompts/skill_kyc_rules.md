---
name: kyc-rules
description: Firm-specific KYC / AML policy applied during corporate
  customer onboarding. Drives the agent's threshold judgments, required
  CDD fields, sanctions screening behavior, and approval-stamp
  formatting. Swap this file to adapt the demo to another institution's
  policy.
---

# KYC Rules

## Beneficial owner threshold
Include any natural person owning **≥25%** of the entity, directly or
indirectly. Do not include:

- Employee option pools held in trust.
- Sub-25% holdings disclosed for completeness.
- Other instruments unless a single individual personally crosses 25%.

## Required CDD fields
For every reportable beneficial owner, the FinCEN CDD form must
capture:

- Full legal name
- Date of birth (`YYYY-MM-DD`)
- Residential address
- SSN or ITIN
- Government ID type + number

Plus exactly one **control person** record with the same fields and a
title / role. The control person is typically the senior managing
official (CEO, COO, or equivalent).

## Sanctions screening
For each reportable beneficial owner and the entity itself, perform a
sanctions screening pass against the **OFAC SDN list**.

For this demo, mock the result as `"No match"` for every name and
state explicitly in chat that the OFAC check passed. Do not fabricate
real OFAC list data.

## Approval stamp
After extract → fill → screen have all completed and the results
reconcile, place an approval stamp on the FinCEN CDD form's
**Section V signature block**.

Stamp content (text annotation, default):

```
APPROVED
{certifier_name}, {certifier_title}
{date}
```

Where:

- `certifier_name` = the compliance officer's full name (from the user
  prompt).
- `certifier_title` = "KYC Compliance Officer".
- `date` = today's ISO date.

If `examples/kyc-demo/assets/approved_stamp.png` exists in the bundle,
prefer a stamp annotation with that image instead of the text variant.

## Approval is conditional
Do **not** apply the approval stamp if any of the following are true:

- A beneficial owner crosses the 25% threshold but is missing a
  required CDD field.
- The OFAC mock returns anything other than "No match".

In those cases, surface the issue in chat as an escalation with a
sticky-note annotation on the CDD page where the gap was detected, and
stop. The compliance officer will resolve before re-running.
