# Dead-letter inspection and replay

Run from backend with an authorized operator database credential: `node scripts/dead-letters.js list 50`. Inspection returns bounded metadata, never message payloads, webhook secrets, or raw error bodies.

After correcting the underlying failure, run `node scripts/dead-letters.js replay <dead-letter-uuid> --confirm`. Replay locks the dead letter and requires an unresolved failed delivery and an enabled webhook. It creates one new pending delivery, commits an audit reference, and preserves the old delivery and attempts. Concurrent or repeated replay of the same letter is rejected. Existing workers deliver the new job with their normal retry bounds, signing, and SSRF protection.

Replay has a new delivery ID. A receiver may have processed the original request before its response was lost: confirm downstream event-level idempotency before replaying side-effecting events. Database credentials are the authorization boundary; do not expose this CLI to application users. User and campaign webhook jobs are supported; this tool does not replay money transfers or arbitrary worker functions.
