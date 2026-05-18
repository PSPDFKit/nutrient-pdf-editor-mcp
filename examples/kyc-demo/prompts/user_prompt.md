I'm onboarding a new corporate banking customer:
**Acme Industries Holdings, Ltd.**

They've submitted their certificate of incorporation and beneficial
ownership declaration (in `examples/kyc-demo/inputs/`).

Please complete the KYC packet end to end:

1. **Extract** the entity details and beneficial owners from the source PDFs.
2. **Fill** the FinCEN CDD Certification (`examples/kyc-demo/forms/03_fincen_cdd_blank.pdf`).
3. **Run an OFAC sanctions check** on every reportable beneficial owner.
4. **Apply my compliance approval stamp** once everything reconciles.

Follow the firm's KYC rules in `examples/kyc-demo/prompts/skill_kyc_rules.md`.

— Sarah Lin, KYC Compliance Officer
