import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Journal } from "../src/journal.ts";
import { MockAdapter, requestFor } from "../src/adapters.ts";
import { slackEvent, jiraEvent, toAdf, validateEvent } from "../src/events.ts";
import { hmacValid, validSlack, validJira } from "../src/auth.ts";
import type { DB, Config, BridgeEvent, SqlValue } from "../src/types.ts";
const cfg: Config = {
  mode: "mock",
  team: "T_DEMO",
  channel: "C_SUPPORT",
  project: "OPS",
  issueType: "Task",
  doneTransition: "31",
  serviceActor: "bridge-service",
};
function setup(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db: DB = {
    all: <T extends Record<string, SqlValue>>(q: string, ...p: SqlValue[]) =>
      sqlite.prepare(q).all(...p) as T[],
    run: (q, ...p) => {
      if (p.length) sqlite.prepare(q).run(...p);
      else sqlite.exec(q);
    },
    transaction: (fn) => {
      sqlite.exec("BEGIN");
      try {
        const result = fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { db, journal: new Journal(db, cfg), mock: new MockAdapter(db, cfg) };
}
const event = (id: string, extra: Partial<BridgeEvent> = {}): BridgeEvent => ({
  id,
  origin: "slack",
  kind: "root",
  thread: "1700000001.000001",
  issue: null,
  text: "Report export is failing",
  actor: "U_DEMO",
  revision: 1000,
  ...extra,
});
test("Slack roots create one Jira ticket and acknowledgement, with round-trip comments and status updates", async (t) => {
  const { journal, mock } = setup(t);
  await journal.accept(event("root"));
  await journal.pump(mock);
  let state = journal.snapshot();
  assert.equal(state.links.length, 1);
  assert.equal(state.effects.length, 2);
  assert.equal(state.events[0].status, "succeeded");
  const link = state.links[0];
  await journal.accept(
    event("slack-reply", {
      kind: "reply",
      text: "It fails after selecting a date.",
    }),
  );
  await journal.pump(mock);
  await journal.accept(
    event("jira-reply", {
      origin: "ticket",
      kind: "reply",
      thread: null,
      issue: link.issue,
      text: "The fix is ready.",
      actor: "jira-engineer",
      revision: 2000,
    }),
  );
  await journal.pump(mock);
  await journal.accept(
    event("jira-status", {
      origin: "ticket",
      kind: "status",
      thread: null,
      issue: link.issue,
      status: "Done",
      actor: "jira-engineer",
      revision: 3000,
    }),
  );
  await journal.pump(mock);
  state = journal.snapshot();
  assert.equal(state.links[0].status, "Done");
  assert.equal(mock.receipts().length, 5);
  assert.ok(
    mock
      .receipts()
      .some((r) =>
        String((r.request as { body: string }).body).includes(
          "The fix is ready.",
        ),
      ),
  );
});
test("Jira-created issues receive a Slack root and replies preserve that correlation", async (t) => {
  const { journal, mock } = setup(t);
  await journal.accept(
    event("jira-root", {
      origin: "ticket",
      thread: null,
      issue: "OPS-40",
      actor: "engineer",
    }),
  );
  await journal.pump(mock);
  const link = journal.snapshot().links[0];
  assert.equal(link.issue, "OPS-40");
  assert.match(link.thread, /^\d+\.\d+$/);
  await journal.accept(
    event("answer", {
      thread: link.thread,
      kind: "reply",
      text: "Additional details",
    }),
  );
  await journal.pump(mock);
  const request = mock.receipts()[0].request as { url: string };
  assert.ok(request.url.endsWith("/OPS-40/comment"));
});
test("the core accepts a replacement ticket adapter with opaque non-Jira identifiers", async (t) => {
  const { journal } = setup(t),
    operations: string[] = [];
  const adapter = {
    execute: async (effect: { kind: string }) => {
      operations.push(effect.kind);
      return effect.kind === "ticket.create"
        ? { issue: "case_opaque_42", id: "created-42" }
        : { thread: "1700000200.000001", id: "delivery-42" };
    },
  };
  await journal.accept(event("alternate-root"));
  await journal.pump(adapter);
  assert.equal(journal.snapshot().links[0].issue, "case_opaque_42");
  await journal.accept(
    event("alternate-reply", {
      origin: "ticket",
      kind: "reply",
      thread: null,
      issue: "case_opaque_42",
      actor: "helpdesk-agent",
      text: "Provider-independent reply",
    }),
  );
  await journal.pump(adapter);
  assert.deepEqual(operations, ["ticket.create", "slack.post", "slack.post"]);
  assert.equal(journal.snapshot().events[0].status, "succeeded");
});
test("duplicate IDs reuse the event; conflicting content never creates another write", async (t) => {
  const { journal, mock } = setup(t);
  const a = event("same");
  await Promise.all([journal.accept(a), journal.accept(a)]);
  await journal.pump(mock);
  assert.equal((await journal.accept(a)).duplicate, true);
  await journal.pump(mock);
  assert.equal(mock.receipts().length, 2);
  await assert.rejects(
    () => journal.accept({ ...a, text: "Different content" }),
    /conflicts/,
  );
  assert.equal(mock.receipts().length, 2);
});
test("equivalent root messages with distinct delivery IDs still create only one ticket", async (t) => {
  const { journal, mock } = setup(t);
  await journal.accept(event("root-a"));
  await journal.accept(event("root-b"));
  await journal.pump(mock);
  assert.equal(journal.snapshot().links.length, 1);
  assert.equal(mock.receipts().length, 2);
  assert.equal(
    journal.snapshot().events.find((e) => e.id === "root-b")?.status,
    "ignored",
  );
});
test("blocked conversation tails do not schedule an endless alarm, while other threads continue", async (t) => {
  const { journal, mock } = setup(t);
  await journal.accept(event("root"));
  await journal.pump(mock);
  mock.fail("timeout_after_write");
  await journal.accept(event("unknown", { kind: "reply" }));
  await journal.pump(mock);
  await journal.accept(event("tail", { kind: "reply" }));
  await journal.pump(mock);
  assert.equal(journal.nextDue(), null);
  await journal.accept(event("other", { thread: "1700000099.000001" }));
  await journal.pump(mock);
  assert.equal(journal.snapshot().links.length, 2);
});
test("restricted Jira comments are ignored before their content enters the bridge", () => {
  const e = jiraEvent(
    {
      webhookEvent: "comment_created",
      issue: { key: "OPS-1", fields: { updated: "2026-10-07T10:00:00Z" } },
      comment: {
        id: "1",
        updated: "2026-10-07T10:00:00Z",
        author: { accountId: "engineer" },
        visibility: { type: "role", value: "Developers" },
        body: toAdf("Private content"),
      },
    },
    cfg,
  );
  assert.equal(e.kind, "ignored");
  assert.equal(e.text, "");
});
test("a reply arriving before its root waits and is delivered after the link exists", async (t) => {
  const { journal, mock } = setup(t);
  await journal.accept(event("early-reply", { kind: "reply" }));
  await journal.pump(mock);
  assert.equal(journal.snapshot().events[0].status, "waiting");
  await journal.accept(event("late-root"));
  await journal.pump(mock);
  assert.equal(mock.receipts().length, 3);
  assert.ok(journal.snapshot().events.every((e) => e.status === "succeeded"));
});
test("bot echoes and service-authored Jira comments are ignored", async (t) => {
  const { journal, mock } = setup(t);
  const slack = slackEvent(
    {
      event_id: "bot",
      team_id: "T_DEMO",
      event: {
        type: "message",
        channel: "C_SUPPORT",
        bot_id: "B_BRIDGE",
        ts: "1700000001.000001",
        text: "Mirrored",
      },
    },
    cfg,
  );
  await journal.accept(slack);
  const jira = jiraEvent(
    {
      webhookEvent: "comment_created",
      issue: { key: "OPS-1", fields: { updated: "2026-10-07T10:00:00Z" } },
      comment: {
        id: "9",
        author: { accountId: "bridge-service" },
        body: toAdf("Mirrored"),
        updated: "2026-10-07T10:00:00Z",
      },
    },
    cfg,
  );
  await journal.accept(jira);
  await journal.pump(mock);
  assert.equal(mock.receipts().length, 0);
  assert.ok(journal.snapshot().events.every((e) => e.status === "ignored"));
});
test("stale Jira status events cannot regress the thread even when planned together", async (t) => {
  const { journal, mock } = setup(t);
  await journal.accept(event("root"));
  await journal.pump(mock);
  const issue = journal.snapshot().links[0].issue;
  await journal.accept(
    event("new", {
      origin: "ticket",
      kind: "status",
      thread: null,
      issue,
      actor: "engineer",
      revision: 4000,
      status: "Done",
    }),
  );
  await journal.accept(
    event("old", {
      origin: "ticket",
      kind: "status",
      thread: null,
      issue,
      actor: "engineer",
      revision: 3000,
      status: "In progress",
    }),
  );
  await journal.pump(mock);
  assert.equal(journal.snapshot().links[0].status, "Done");
  assert.equal(mock.receipts().length, 3);
  assert.equal(
    journal.snapshot().events.find((e) => e.id === "old")?.status,
    "ignored",
  );
});
test("safe rate limits back off, while ambiguous writes require reconciliation and block later comments", async (t) => {
  const { journal, mock } = setup(t);
  mock.fail("rate_limit");
  await journal.accept(event("limited"));
  await journal.pump(mock);
  assert.equal(mock.receipts().length, 0);
  assert.equal(journal.snapshot().events[0].status, "retrying");
  await journal.pump(mock, Date.now() + 2000);
  assert.equal(mock.receipts().length, 2);
  mock.fail("timeout_after_write");
  await journal.accept(event("reply-1", { kind: "reply" }));
  await journal.pump(mock);
  await journal.accept(event("reply-2", { kind: "reply" }));
  await journal.pump(mock);
  const held = journal
    .snapshot()
    .effects.find((e) => e.status === "uncertain")!;
  assert.equal(mock.receipts().length, 3);
  assert.throws(() => journal.reconcile(held.key, {}), /receipt/);
  const receipt = mock
    .receipts()
    .find((r) => r.key === "reply-1:ticket.comment")!.receipt;
  journal.reconcile(held.key, receipt);
  await journal.pump(mock);
  assert.equal(mock.receipts().length, 4);
});
test("an interrupted sending state recovers as uncertain and retains link state", async (t) => {
  const { db, journal, mock } = setup(t);
  await journal.accept(event("root"));
  await journal.pump(mock);
  await journal.accept(event("pending", { kind: "reply" }));
  journal.prepare();
  db.run("UPDATE effects SET status='sending' WHERE event_id='pending'");
  const reopened = new Journal(db, cfg);
  assert.equal(reopened.snapshot().links.length, 1);
  assert.equal(reopened.snapshot().effects[0].status, "uncertain");
  await reopened.pump(mock);
  assert.equal(mock.receipts().length, 2);
});
test("configuration changes cannot turn old mock or queued state into live deliveries", async (t) => {
  const { db, journal, mock } = setup(t);
  await journal.accept(event("queued"));
  const changed = new Journal(db, { ...cfg, mode: "live" });
  assert.equal(changed.snapshot().configuration_paused, true);
  assert.equal(changed.snapshot().mode, "mock");
  await assert.rejects(() => changed.pump(mock), /Configuration drift/);
  assert.equal(mock.receipts().length, 0);
  const restored = new Journal(db, cfg);
  await restored.pump(mock);
  assert.equal(mock.receipts().length, 2);
});
test("reactions request a configured Jira transition without claiming it has already completed", async (t) => {
  const { journal, mock } = setup(t);
  await journal.accept(event("root"));
  await journal.pump(mock);
  await journal.accept(
    event("reaction", { kind: "reaction", reaction: "white_check_mark" }),
  );
  await journal.pump(mock);
  assert.equal(journal.snapshot().links[0].status, "Open");
  assert.ok(mock.receipts().some((r) => r.kind === "ticket.transition"));
  const issue = journal.snapshot().links[0].issue;
  const confirmation = jiraEvent(
    {
      webhookEvent: "jira:issue_updated",
      issue: {
        key: issue,
        fields: { updated: "2026-10-07T10:00:00Z", status: { name: "Done" } },
      },
      user: { accountId: cfg.serviceActor },
      changelog: { items: [{ field: "status" }] },
    },
    cfg,
  );
  assert.equal(confirmation.kind, "status");
  await journal.accept(confirmation);
  await journal.pump(mock);
  assert.equal(journal.snapshot().links[0].status, "Done");
});
test("request adapters stamp loop metadata, use Jira ADF and exclude arbitrary destination hosts", () => {
  const request = requestFor(
    {
      kind: "ticket.comment",
      thread: "1700000001.000001",
      issue: "OPS-1",
      text: "Line one\nLine two",
      eventId: "e",
    },
    cfg,
    {
      slackToken: "token",
      jiraBase: "https://example.atlassian.net",
      jiraEmail: "user@example.test",
      jiraToken: "token",
    },
  );
  const body = JSON.parse(request.body);
  assert.equal(body.body.content.length, 2);
  assert.equal(body.properties[0].key, "threadbridge.origin");
  assert.throws(
    () =>
      requestFor(
        {
          kind: "ticket.create",
          thread: null,
          issue: null,
          text: "a",
          eventId: "e",
        },
        cfg,
        {
          slackToken: "",
          jiraBase: "https://localhost",
          jiraEmail: "",
          jiraToken: "",
        },
      ),
    /Jira Cloud/,
  );
  assert.throws(
    () => validateEvent({ ...event("invalid"), thread: "not-a-timestamp" }),
    /thread/,
  );
});
test("Slack and Jira request signatures validate the raw body and reject stale or tampered payloads", async () => {
  const now = Date.now(),
    stamp = String(Math.floor(now / 1000)),
    raw = '{"event":"synthetic"}',
    secret = "synthetic-signing-secret";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = async (message: string) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(message),
        ),
      ),
    )
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
  const slack = new Request("https://example.test", {
    headers: {
      "x-slack-request-timestamp": stamp,
      "x-slack-signature": "v0=" + (await signature(`v0:${stamp}:${raw}`)),
    },
  });
  assert.equal(await validSlack(slack, raw, secret, now), true);
  assert.equal(await validSlack(slack, raw + "x", secret, now), false);
  assert.equal(await validSlack(slack, raw, secret, now + 301000), false);
  const jira = new Request("https://example.test", {
    headers: { "x-hub-signature": "sha256=" + (await signature(raw)) },
  });
  assert.equal(await validJira(jira, raw, secret), true);
  assert.equal(await hmacValid(secret, "sha256=bad", raw, "sha256="), false);
});
