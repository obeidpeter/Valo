# Valo rebrand

Valo is the current product name; Valo Today is the role-aware workspace.
The current folded-ribbon logo, downloadable files and regeneration checks are
documented in [Valo Logo](valo-logo.md).
Current product copy, mobile display names, and the UI V mark replace the
MeridianIQ / Meridian Today branding. Product demo addresses use
`@valo.example`; these are synthetic fixtures, not public contact addresses.
Named demo businesses retain their separate fixture identities.

This is a presentation change with additive compatibility support, not a
database, identity-provider, or mobile signing migration. It does not change
tenant isolation, permissions, consent, audit evidence, or approval boundaries.
The current API contract version is defined in
[OpenAPI](../lib/api-spec/openapi.yaml); regenerate the clients from it and
promote matching API and web artifacts through the existing
[release path](operations.md). Existing rollback qualifications still apply.

## Compatibility behavior

### Request headers

| Preferred header | Retained alias | Purpose |
| --- | --- | --- |
| `x-valo-csrf` | `x-meridian-csrf` | Custom-header guard for browser mutations. |
| `x-valo-workspace` | `x-meridian-workspace` | Workspace selection, including buyer membership selection. |
| `x-valo-client` | `x-meridian-client` | Native-client identification for the authentication flow. |

The API accepts either name. When both names for one header are present,
their values must match; conflicting values fail with `BAD_REQUEST` rather
than selecting an ambiguous value. These headers do not replace credentials
or grant access. Existing clients can continue using the legacy names.
The e2e harness sends the Valo spelling on every fixture call, and its
brand-compatibility journey pins the retained aliases, the conflict refusal,
the webhook header parity and the metric twins against the built server
(R112).

### Outbound webhooks and metrics

Each outgoing firm webhook includes matching `x-valo-signature` and
`x-meridian-signature` values, plus matching `x-valo-event` and
`x-meridian-event` values. This is one delivery with two header names, not
two events. Signature calculation remains HMAC-SHA256 over the raw body,
keyed by the lowercase hex SHA-256 hash of the shown-once `whsec_` secret.
Receiver verification, event IDs, retries, and deduplication stay unchanged.

`/api/metrics` exposes the new `valo_*` metric names and the corresponding
`meridian_*` aliases with the same labels and values. For example,
`valo_sweep_runs_total` aliases `meridian_sweep_runs_total`, and
`valo_outbox_events` aliases `meridian_outbox_events`. Move dashboards and
alerts to the new names deliberately; do not sum both aliases and double-count
one measurement. Existing dashboards may continue using the old names.

### TOTP and installed web apps

New authenticator setup links use issuer **Valo**. Existing entries labelled
**MeridianIQ** remain valid: the issuer label is not part of TOTP code
generation, and the rename does not rotate stored secrets or recovery codes.
Do not disable or re-enrol 2FA solely to update an authenticator label.

The SME service worker uses `valo-sme-static-v5`. On activation it removes
old `meridianiq-sme-static-*` caches, legacy `meridianiq-v<number>` caches,
and older `valo-sme-static-*` caches while retaining the current cache.
Only public fingerprinted static assets inside its app scope are cached;
navigations, APIs, downloads, requests with an `authorization` header, and
sibling apps still bypass it. The landing worker remains a no-op root-worker repair path.
This cache cleanup is not a session or persisted-work reset.

## Intentionally stable identifiers

- **Repository identity:** the GitHub repository was renamed from
  `obeidpeter/Meridian-IQ` to `obeidpeter/Valo` by the project owner on
  2026-09-10 (R125). GitHub redirects the old slug for web URLs, clones,
  fetches and pushes, so links in historical records are left as written and
  keep resolving; new links use the new slug. Never create a repository named
  `Meridian-IQ` under the same owner, because that would end the redirect.
  The Replit workspace remote should point at the new slug
  (`git remote set-url origin https://github.com/obeidpeter/Valo.git`).
- **External destinations:** the project owner selected `valo-platform.replit.app`
  as the replacement application domain after the shorter name was unavailable.
  `advisory@meridianiq.com` remains pending
  a user-supplied, verified replacement. Do not infer a new mailbox from the
  Valo name, and do not use `valo.example` as a production destination.
- **Database contracts:** retain `meridian_app`, `meridian_tenant_isolation`,
  `meridian_append_only`, `meridian_block_mutations`, `meridian_purge_expired`,
  migration names/numbers, and other applied SQL identifiers. Disposable
  `meridian_ci` / `meridian_drill*` database names are not product copy.
- **Recovery evidence:** retain `meridian-release-<sha>`, `meridian-*.dump`,
  backup directory and lock names, manifest/checksum formats, revision hashes,
  and historical version references. Do not rename retained archives or
  regenerate their hashes to make the evidence appear newly branded.
- **Business and provider contracts:** retain `miq-credit-scorecard-1.0.0`,
  `miq-credit-rules-1.0.0`, `miq-collection-feed-1.0.0`, and the
  `meridian-relay` connector ID. Provider IDs, credentials, event identifiers,
  and stored provenance are not display names. The access-point profile keeps
  its existing `v0` wire shape despite the Valo prose label.
- **Business records:** existing tenant names, legal names, white-label
  identities and historical documents are not batch-renamed. Fresh synthetic
  demo data uses Valo names; an existing business record is not product copy.
- **Sessions and local state:** retain cookies such as `miq_session` and
  `miq_invoice_room`, mobile keys such as `miq_token`, `miq_me`,
  `miq_push_token`, `miq_client_party`, and `miq_invoice_intent:`, plus existing
  `meridianiq:*` browser storage/event keys and the `meridianiq-session`
  channel. Preserve cryptographic inputs and session invalidation semantics.
- **Mobile application identity:** retain the iOS bundle identifier and
  Android package `com.meridianiq.mobile`, existing EAS/provider project IDs,
  and signing identity. The Valo display name is not a new application.
- **Legacy safety checks:** old branded demo addresses remain in production
  disable lists alongside the new fixtures so copied development accounts
  cannot become usable through a cosmetic rename.
- **Historical originals:** leave `docs/history/`, `docs/ux-audit-2026-08/`,
  maintainability historical evidence, and original attached
  `attached_assets/MeridianIQ_*.docx` files unchanged. References to the original
  MeridianIQ Technical Requirements Document v1.1 retain its actual title and
  requirement IDs; do not replace the attached original with a renamed copy.

## External rollout checklist

These steps require deployment-owner action and evidence. They are not
completed by source edits or documentation checks.

- [x] Rename the GitHub repository to `obeidpeter/Valo` (done 2026-09-10; the
  old slug redirects). Update its description if it still names the old
  Replit project URL, and re-point the Replit workspace remote. The Replit
  project display name is Valo.
- [ ] Publish the renamed project so `valo-platform.replit.app` becomes live. Verify
  routing, TLS, redirects, app links, allowed origins, and mobile API targets;
  coordinate `PUBLIC_APP_URL` and deployment settings with that selected URL.
- [ ] Keep `advisory@meridianiq.com` until a replacement is supplied and verified.
  Coordinate email/DNS and sender display names with the mailbox owner, check
  SPF/DKIM/DMARC and delivery/reply handling, retain continuity for old mail,
  and record the inbox evidence required by [release readiness](release-readiness.md).
- [ ] Update the **Clerk identity provider** application display name, hosted
  sign-in UI, and email branding. Verify sign-in, existing sessions, and
  callbacks; retain provider IDs, keys, and existing verified domains until
  a separate domain change is approved. This provider is distinct from the
  product's Clerk AI assistant.
- [ ] Update App Store Connect and Google Play listing display names and
  screenshots for Valo Mobile. Verify the installed label and upgrades on
  existing installations. Do not change `com.meridianiq.mobile`, signing
  identities, provisioning profiles, or EAS project IDs for a cosmetic rename.
  Ship a new native build for the installed app name, icons and URL scheme;
  publishing web assets or JavaScript bundles alone does not replace installed
  native application metadata.
- [ ] Check that existing APNs push certificates/keys and Android push
  credentials still match the unchanged app IDs, then test notification
  delivery and tap-through on physical iOS and Android devices. Do not rotate
  or replace signing/push credentials just to change the product label.
- [ ] Verify the released API and web handshake reports `0.102.0`, new and
  legacy request headers work, mismatched pairs fail, outgoing webhook aliases
  agree, and metric aliases have parity. Check dashboards for double-counting.
- [ ] Test a returning browser with old SME caches: the new worker activates,
  old owned caches disappear, the Valo name/V mark appears, and sign-in and
  saved work remain intact. Verify an existing MeridianIQ TOTP entry still
  signs in and a new setup link shows issuer Valo.

For local documentation validation, run `pnpm run docs:check`. Application,
integration, and deployment checks remain separate release evidence.

### Replit hostname cutover

The generated hostname is separate from the project display name. Replit's
initial publishing form reported `valo-platform.replit.app` available on
2026-09-08 in an empty, unpublished temporary project. Availability is not a
reservation; recheck it before the approved production cutover.

Prepare a fresh seven-app CI artifact for the exact merged revision before
unpublishing the existing deployment. Preserve its verified package and release
evidence. Shutdown removes the saved hostname and deployment history; it does
not provide an automatic redirect from the old hostname.

Reuse the existing production database and its enforced geography. Never delete
the retained database to satisfy the new-publish form, create a substitute, or
copy development data over production. Preserve credentials and relative Clerk
proxy paths. Set `PUBLIC_APP_URL` and `RELEASE_BASE_URL` to the selected origin
(since R112 the API holds readiness until `PUBLIC_APP_URL` is a safe https
origin; no hostname in the code stands in for it);
check any explicit `SWEEP_URL` and external provider callbacks/allowlists.

Finalize the trusted `RELEASE_MANIFEST_SHA256` setting and verify its actual
workspace-sync behavior before staging. Settings changes can restart development
workflows and regenerate ignored build output. Stop all seven workflows, replace
all seven complete `dist` trees and the manifest/sidecar with the exact CI archive,
and rerun all artifact-only gates immediately before publication. Do not rebuild
locally, bypass the gates, or rely on a failed publish to retain edited settings.

Verify health, readiness, all public asset hashes, routing, allowed origins and
database continuity at the new hostname. Host-only browser sessions do not move
between hostnames; users must sign in again. Installed native builds and external
bookmarks/callbacks also require deliberate updates. Keep the external checklist
open until those checks have supporting evidence.

## Local verification (2026-09-07)

The rebrand was checked locally against synthetic data, not production:

- `pnpm run check`: typechecking, lint, architecture, secret scan, documentation,
  branding and 1,596 unit/pure tests passed. Two existing hook lint warnings in
  `artifacts/sme-compliance/src/lib/use-invoice-drafts.ts` remain unchanged.
- API and all five web production builds passed; public assets match their
  final built copies. Measured route bundle budgets passed for all five apps.
- Both native bundles built, and the packaged mobile manifest/asset checks
  passed. Physical-device installation, upgrade and push checks remain open.
- The reliability suite passed 242 tests, including service-worker cache
  cleanup and release/recovery safeguards. Its release actions use fixtures;
  they did not publish or modify a deployment.
- API-client tests passed 6 cases, including dual-header propagation,
  conflicting-value preservation and first-party credential boundaries.
- Browser suites passed 46 checks covering landing/login accessibility,
  workspace usability, calculator loading, white-label colors and notification
  contrast. A separate real-API local preview smoke verified cookie-only
  sign-in and responsive Valo Today rendering.
- Disposable PostgreSQL 16 verification passed 74 focused backend tests and
  7 new main-app integration cases. An expanded PDF battery passed 28 tests
  (5 overlap the focused battery). Eight parsed metadata checks confirmed
  Creator Valo and preserved white-label Authors across four PDF renderers.
- The complete built-platform E2E suite passed 424/424 checks with real
  disposable PostgreSQL, including the role/viewport accessibility matrix,
  authentication, WHT, workflow, webhook and concurrency/recovery journeys.

Verification also exposed two Windows test-tool portability issues: the E2E
rail now launches the resolved `tsx` CLI with Node, and the shared PostgreSQL
query helper uses explicit `--dbname` so Windows psql does not silently ignore
options following a positional database argument. Neither change weakens
application permissions, fixture assertions or credential redaction.

No production publication or external-provider changes were performed during
this verification. The external rollout checklist above remains separate from
these local checks.
