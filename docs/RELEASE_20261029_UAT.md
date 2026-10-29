# 2026-10-29 browser relay UAT release candidate

Version: `browser-relay-uat-20261029-r1`, browser-only branch `feature/browser-peer-relay`. This candidate marker is not publication or company-deployment evidence.

## Scope

- New meetings default to relay enabled only when the deployment-wide gate is already enabled. Retain host diagnostics and explicit per-room off/on; see BROWSER_RELAY_DEFAULT_ON_UAT.md.
- Replace annotation glyphs with project-drawn SVG icons; see ANNOTATION_ICONS_UAT.md. No external assets or new runtime packages.
- Keep company login configuration, certificate trust, storage format, bandwidth, explicit viewer limits and all other deployment environment unchanged.

## First candidate blocked; do not publish it

The original commit `d8338d707454950f9af109463526f998e418e08f` failed the image security gate in CI run `40803858805`. Its application/backend-builder reports flagged github.com/go-jose/go-jose/v4 v4.1.4: CVE-2026-116585, CVE-2026-116586 and CVE-2026-116587. The reports identify v4.1.6 as covering all three fixes. No image from that failed candidate is approved for publication.

Upgrade only this existing dependency to v4.1.6 and update the license inventory. Do not disable scans, ignore findings, lower severity thresholds, skip failures or reuse a previously built candidate. The patched exact commit must rerun both complete existing Linux CI jobs; only its same-run tested-container may be released, with blob/config/revision/platform/user/frontend verification and post-publication downloads.

## Deployment and acceptance

Independent prerelease, not latest or a stable tag; do not change main. Image-only update during an idle meeting window, preserving the actual old image in a version-specific create-only backup for rollback. A restart interrupts active meetings. An image-reference backup is not a storage backup.

Everyone reloads after upgrading. Verify default relay in a new room without manually enabling it, diagnostics, manual disable persistence, distinct cursor/target/arrow icons, drawing/grants/revoke/hide/show, mobile and fullscreen. CI/local fixtures do not replace company SSO, physical sleep/lock, real screen capture or cross-building/vendor network acceptance. No smooth 64/100-person capacity claim or guarantee of no interruptions.
