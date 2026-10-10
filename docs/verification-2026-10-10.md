# Verification — 2026-10-10

24 tests pass on Windows Node 24 and WSL Docker. Type checking and the Wrangler deployment dry run pass. Nine isolated Workerd checks pass with SQLite-backed Durable Objects and alarms: authentication, signed Slack/Jira ingress, service-account status confirmation, alarm delivery, restart persistence, duplicate protection, full wire-envelope replay and file-share reply handling.

The full-envelope fixtures in `fixtures/wire-payloads.json` follow native provider schemas and contain fictional identifiers and content. They are not customer recordings. The inspected company exports expose enriched Zapier outputs such as `user.profile.email` and flattened file arrays. Tests prevent these from being mistaken for native Slack envelopes.

New coverage verifies Unicode content, identity and stable millisecond timestamps, attachment-bearing replies, private-download URL exclusion, ADF mentions/emoji/inline cards, restricted comments, wrong-workspace/project rejection, bounded streams and an attention queue for lost root receipts before a ticket link exists.

The resulting fixes preserve attachment permalinks without downloading files, retain rich Jira text, escape Slack special characters and remove floating-point timestamp drift. Native Slack user identifiers are validated explicitly.

The browser replays full Slack root/file-reply and Jira comment envelopes through the actual Worker. It preserves their correlation and shows recorded delivery receipts. The conversation queue, search/filter controls, timeline, comparison view, inspection and replay drawer replace the previous dashboard-first layout. Mock providers remain explicit.

Browser review also exercised a lost create-ticket receipt, the unlinked attention item and receipt-based recovery without a repeated create request. Search reset restores the full queue. Desktop and 390px phone views were inspected. Small interface labels have an 11px minimum. The saved queue, eight events and eleven mock delivery receipts survived a preview rebuild and desktop app restart.

Original customer messages, routing identifiers, credentials and private code are excluded from public fixtures and screenshots. Live API compatibility, OAuth/permissions, binary-file transfer, edits/deletes and production cutover remain unverified. Free Oracle account recovery/signup is separate from this local work.
