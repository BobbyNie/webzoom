# WebZoom implementation baseline

## Requirements

- Browser traffic uses HTTPS/WSS only. No WebRTC, TURN, UDP, audio or camera.
- Desktop Chromium browsers; screen capture → WebCodecs VP8 → bounded WebSocket relay → WebCodecs canvas rendering.
- Keycloak OIDC authorization code + PKCE. All participants authenticate.
- Any authenticated user creates a room. One authorized publisher at a time. Only the owner transfers publishing or ends a room.
- Single Go instance, in-memory state, React/TypeScript frontend. Restart invalidates rooms and sessions.
- Docker Compose TLS proxy and OpenShift edge Route; non-root arbitrary UID image.
- Goal: 5 rooms × 200 viewers, 1080p30 and p95 capture-to-render ≤ 1 second. Degradation is visible and is not a substitute for passing the normal-quality target.
- Room expiry: 8 hours; empty-room expiry: 30 minutes.

## Delivery gates

1. Unit-tested wire format and bounded relay; measured synthetic fan-out.
2. Browser VP8 encode/decode prototype. Record limits of local results.
3. OIDC, session, CSRF and permission tests before production implementations.
4. Room UI, transfer, reconnect, congestion feedback and visible degradation.
5. Container and proxy verification; reproducible 30-minute deployment acceptance procedure.

All code follows red → green → refactor. Commit each verified increment.
Never claim production capacity based only on synthetic connections. Target-intranet acceptance requires deployed Keycloak, certificates, proxy, network and real Chromium clients.
