# Verification — 2026-10-07

16 Node tests pass. TypeScript checking and Wrangler deployment dry run pass. The dependency audit reports zero known vulnerabilities after overriding the vulnerable image-processing dependency in development tooling.

The isolated local Workers check runs in WSL Docker and exercises the real Workerd runtime with Durable Object SQLite and alarms. It verifies control authentication, signed Slack ingress, signed Jira ingress, background alarm delivery, state after runtime restart, duplicate protection after that restart, and service-account status confirmation. Providers are deterministic mocks. No Slack or Jira write is sent externally.

The browser console was used to create a synthetic Slack request, inspect its Jira link, send a Jira reply, simulate an applied write with a lost response, inspect the distinct mock-provider evidence and reconcile the delivery. Completed receipts were reused. The visible conversation survives app-container rebuilds.

A Jira status change was also mirrored to the thread. The 390-pixel mobile viewport has no horizontal document overflow. The viewport override was reset before recording the desktop screenshot.

Coverage includes early replies waiting for their root, bot/service echoes, conflict detection, duplicate roots with different delivery IDs, stale status within a planned batch, blocked tails without an alarm loop, independent conversations continuing, restricted comment suppression, rate-limit backoff, uncertain receipt recovery, interrupted writes and reaction status semantics.

Actual provider permission checks, Jira field/transition configuration, OAuth installation, confidential-data policies, scaled load, live sandbox parity and production cutover remain unverified. The simulator demonstrates the implementation and request contracts, not a live SaaS integration.

No company data or source backup is included. All examples and recorded screenshots are original synthetic data. Source exports were inspected locally to understand contract families, not copied into the showcase.
