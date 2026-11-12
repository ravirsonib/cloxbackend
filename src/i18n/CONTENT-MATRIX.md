# i18n content matrix (admin + API)

Logged-in product locales: **`en` | `hi` | `pa`**. Public `web/` is frozen pre-launch and is out of this workstream.

Also mirrored at `docs/engineering/i18n-content-matrix.md` (local docs tree).

## What is translated vs stored verbatim

| Layer | What | Language rule |
|---|---|---|
| **Enum / system codes** | DB enum values (`TripExceptionKind`, statuses, roles) | Stable **English codes** in DB/API. Never localize codes. |
| **UI chrome labels** | Buttons, nav, status pills, kind labels | Admin `t()` via i18next (`admin/src/locales/{en,hi,pa}/common.json`). |
| **Account preference** | `User.locale` / `AdminUser.locale` | Persisted; drives UI restore + outbound notify language. |
| **Lead preference** | `Lead.locale` | Used for pre-account lead emails only (web submit unchanged). |
| **Outbound email / inbox** | OTP, lead welcome, exception/bid templates | Recipient locale via `tNotify` / `notifyUsersLocalized`. |
| **UGC** | Job titles, notes, free-text reasons | Stored **exactly as typed** (Unicode). Never AI-rewritten on save. |
| **On-read UGC (optional)** | `ContentTranslation` cache + `POST /translations/preview` | Viewer may Translate / Show original in admin; source columns untouched. |
| **PDFs (AU Phase 1)** | Legal/ops templates | Template copy stays **English** for compliance; embedded UGC as typed. |
| **Money / dates** | AUD formatting | Keep `en-AU` money until multi-currency; datetime may follow UI locale. |

## Code vs label

- **Code** = API/DB value (`VEHICLE_BREAKDOWN`).
- **Label** = admin catalog key e.g. `trips.exceptionKinds.VEHICLE_BREAKDOWN`.
- Clients must map codes → labels locally (or a future API `labels` map for Flutter).

## Guardrails

- Do not dual-column UGC (`note_en` / `note_hi`).
- Do not translate DB enum values into localized strings.
- Do not change files under `web/` in this workstream.
- Key-parity CI: admin `en` ↔ `hi` ↔ `pa` (`npm run i18n:parity` in admin).
