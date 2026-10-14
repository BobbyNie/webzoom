# Working agreements

- Presenter-feedback maintenance stays on `feature/presenter-feedback-on-leader-main`; do not create a branch per revision.
- User-authorized exception (2026-10-14): LAN UDP relay and Chrome client work stays on independent `feature/lan-udp-relay`. No production deployment, release or main merge is implied.
- Do not change main, leader-owned branches, stable `v*` tags, or `latest` without explicit authorization.
- Before building/publishing/updating OCP, read `docs/COMPANY_OCP_RELEASE_RUNBOOK.md` and `docs/ANNOTATION_UAT.md`.
- Linux/Podman is for image transfer; company OCP commands run in Windows PowerShell, NOT Bash.
- Existing working OCP deployments get image-only updates. Preserve live SSO, admin, CA, PVC and security settings. Never reapply an older deployment YAML.
- Do not invent unknown image hashes, live cluster state, credentials, or successful verification results. Ask for unknown nonsecret values; never ask for secret values.
- Keep releases immutable and attributable to a successful CI run at the exact source commit. Failed candidate images must not be published.
- Read local deployment memory outside this Git repository if present. Never commit company credentials or private deployment exports.
