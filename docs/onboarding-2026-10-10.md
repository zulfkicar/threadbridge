# Public onboarding walkthrough

The six-stage walkthrough is at `/demo/` locally and [on the portfolio](https://zulfkicar.github.io/apps/threadbridge/). No provider account or control token is needed. Source events are original synthetic Slack/Jira wire envelopes. The browser loads the production event parsers, planner, Journal and MockAdapter, with an in-memory SQLite WASM database in a Web Worker.

The visitor creates a linked request, replies from Jira and Slack, replays a duplicate, sends a bot echo, simulates a write with a lost receipt, reconstructs the journal, reconciles the matching mock receipt and confirms a Jira Done notification. Conversation, event/effect journal, raw payloads, exact adapter requests and source files are inspectable.

Node tests: **26/26 passed**, including two new SQLite WASM tests. Local Workerd checks: **9 passed** with mocked outbound. TypeScript checking and deployment dry run passed. The complete visitor flow was also exercised through the browser. Duplicate and echo steps retained four simulated writes. The lost receipt produced a fifth simulated write and one uncertain effect. Journal reconstruction retained that hold. Reconciliation cleared it without adding another write. A confirmed Jira Done event resolved the link.

The browser database clears on reload. Journal reconstruction reuses the same database in the same worker. The demo does not simulate Cloudflare process restarts, persist records between browser sessions, validate HMAC ingress, or test live Slack/Jira permissions. Those boundaries are stated in the technical view.

Rebuild with `npm run build:demo`. The browser asset contains SQL.js and the bridge source modules. SQL.js WASM is served from the same origin. Build dependencies and their exact resolved versions are in `package-lock.json`. No destination transport is exposed in this demo.

Publication was verified at [the hosted walkthrough](https://zulfkicar.github.io/apps/threadbridge/), with source at [zulfkicar/threadbridge](https://github.com/zulfkicar/threadbridge). Repository CI and portfolio Pages deployment succeeded. The hosted worker loaded SQLite WASM, accepted the native sample event and created the thread/ticket link. The portfolio and profile README link to the walkthrough and repository.
