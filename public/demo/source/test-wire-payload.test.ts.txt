import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { slackEvent, jiraEvent } from "../src/events.ts";
import { requestFor, boundedText } from "../src/adapters.ts";
import { queueItems } from "../public/presentation.js";
import type { Config } from "../src/types.ts";
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/wire-payloads.json", import.meta.url),
    "utf8",
  ),
);
const cfg: Config = {
  mode: "mock",
  team: "T_DEMO",
  channel: "C_SUPPORT",
  project: "OPS",
  issueType: "Task",
  doneTransition: "31",
  serviceActor: "demo-service",
};
test("full Slack wire envelope preserves Unicode, source identity and event time", () => {
  const result = slackEvent(fixture.slack_message, cfg);
  assert.equal(result.id, "Ev_WIRE_ROOT");
  assert.equal(result.kind, "root");
  assert.equal(result.actor, "U_MEMBER_DEMO");
  assert.equal(result.thread, "1791374400.000013");
  assert.match(result.text, /براہ/);
  assert.equal(result.revision, 1791374400000);
});
test("file-share replies retain public permalinks and never forward private download URLs", () => {
  const result = slackEvent(fixture.slack_file_reply, cfg);
  assert.equal(result.kind, "reply");
  assert.equal(result.thread, fixture.slack_message.event.ts);
  assert.match(result.text, /Diagnostic log/);
  assert.match(result.text, /example.slack.com\/files/);
  assert.ok(!result.text.includes("files-pri"));
  const unsafe = structuredClone(fixture.slack_file_reply);
  unsafe.event.files[0].permalink = "https://other.example.test/?token=secret";
  assert.ok(!slackEvent(unsafe, cfg).text.includes("token="));
});
test("enriched Zapier user objects cannot be mistaken for native Slack payloads", () => {
  const result = structuredClone(fixture.slack_message);
  result.event.user = {
    id: "U_MEMBER_DEMO",
    profile: { email: "member@example.test" },
  };
  assert.throws(() => slackEvent(result, cfg), /Enriched Zapier/);
});
test("ADF mention, emoji, inline card and timezone offset survive comment normalization", () => {
  const result = jiraEvent(fixture.jira_comment, cfg, "delivery-comment-1");
  assert.equal(result.kind, "reply");
  assert.equal(result.actor, "account_demo_engineer");
  assert.equal(result.revision, 1791374460000);
  assert.equal(
    result.text,
    "The failure affects A & B. @Example member can verify the fix ✅\nhttps://example.test/issues/OPS-1",
  );
  const request = requestFor(
    {
      kind: "slack.post",
      thread: "1791374400.000013",
      issue: "OPS-1",
      text: result.text,
      eventId: result.id,
    },
    cfg,
    { slackToken: "placeholder", jiraBase: "", jiraEmail: "", jiraToken: "" },
  );
  assert.match(JSON.parse(request.body).text, /A &amp; B/);
});
test("restricted comments are suppressed and service-actor status confirmations are accepted", () => {
  const restricted = structuredClone(fixture.jira_comment);
  restricted.comment.jsdPublic = false;
  assert.equal(jiraEvent(restricted, cfg).kind, "ignored");
  assert.equal(jiraEvent(restricted, cfg).text, "");
  const status = jiraEvent(fixture.jira_status, cfg);
  assert.equal(status.kind, "status");
  assert.equal(status.status, "Done");
  assert.equal(status.actor, "demo-service");
});
test("payloads from a different workspace or project are rejected", () => {
  const slack = structuredClone(fixture.slack_message);
  slack.team_id = "T_OTHER";
  assert.throws(() => slackEvent(slack, cfg), /configured bridge/);
  const jira = structuredClone(fixture.jira_comment);
  jira.issue.key = "OTHER-1";
  assert.throws(() => jiraEvent(jira, cfg), /configured project/);
});
test("bounded stream rejects excessive payloads instead of buffering indefinitely", async () => {
  await assert.rejects(
    () => boundedText(new Response("x".repeat(1025)), 1024),
    /exceeds/,
  );
});
test("the attention queue includes a lost root receipt before any ticket link exists", () => {
  const state = {
    links: [],
    events: [
      {
        id: "root",
        created: 1000,
        status: "held",
        payload: {
          thread: "1791374400.000013",
          issue: null,
          text: "Invoice failure",
          kind: "root",
        },
      },
    ],
  };
  const items = queueItems(state);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "attention");
  assert.equal(items[0].link, null);
});
