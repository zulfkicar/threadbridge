import { spawn } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
const vars = Object.fromEntries(
  readFileSync(".dev.vars", "utf8")
    .split(/\r?\n/)
    .filter((x) => x.includes("="))
    .map((x) => {
      const p = x.indexOf("=");
      return [x.slice(0, p), x.slice(p + 1)];
    }),
);
const dataRoot = resolve(".data");
mkdirSync(dataRoot, { recursive: true });
const directory = mkdtempSync(join(dataRoot, "worker-smoke-")),
  base = "http://127.0.0.1:8898";
async function start() {
  const child = spawn(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      "8898",
      "--inspector-port",
      "0",
      "--persist-to",
      directory,
    ],
    {
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout.on("data", (x) => (log += x));
  child.stderr.on("data", (x) => (log += x));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill();
      await Promise.race([
        ended,
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 3000);
          timer.unref();
        }),
      ]);
    }
  };
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(base + "/api/state", {
        signal: AbortSignal.timeout(200),
      });
      if (r.status === 401) return { stop };
    } catch {}
    if (child.exitCode !== null) {
      throw Error("Local Worker exited: " + log.slice(-1500));
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await stop();
  throw Error("Local Worker did not start: " + log.slice(-1500));
}
const api = async (path, body) => {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + vars.ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  return result;
};
let running;
try {
  running = await start();
  const event = {
    id: "smoke-root",
    origin: "slack",
    kind: "root",
    thread: "1700000100.000001",
    issue: null,
    text: "Synthetic smoke-test request",
    actor: "U_TEST",
    revision: 1000,
  };
  const first = await api("/api/demo/event", { event });
  assert.equal(first.state.links.length, 1);
  assert.equal(
    first.state.effects.filter((e) => e.status === "succeeded").length,
    2,
  );
  const issue = first.state.links[0].issue;
  const raw = JSON.stringify({
      team_id: "T_DEMO",
      event_id: "signed-slack-reply",
      event: {
        type: "message",
        channel: "C_SUPPORT",
        user: "U_TEST",
        ts: "1700000101.000001",
        thread_ts: event.thread,
        text: "Signed synthetic reply",
      },
    }),
    stamp = String(Math.floor(Date.now() / 1000));
  const signature =
    "v0=" +
    createHmac("sha256", vars.SLACK_SIGNING_SECRET)
      .update(`v0:${stamp}:${raw}`)
      .digest("hex");
  assert.equal(
    (
      await fetch(base + "/events/slack", {
        method: "POST",
        headers: {
          "x-slack-request-timestamp": stamp,
          "x-slack-signature": "v0=bad",
        },
        body: raw,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(base + "/events/slack", {
        method: "POST",
        headers: {
          "x-slack-request-timestamp": stamp,
          "x-slack-signature": signature,
        },
        body: raw,
      })
    ).status,
    202,
  );
  let snapshot;
  for (let i = 0; i < 30; i++) {
    snapshot = await api("/api/state");
    if (
      snapshot.events.some(
        (e) => e.id === "signed-slack-reply" && e.status === "succeeded",
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(
    snapshot.events.some(
      (e) => e.id === "signed-slack-reply" && e.status === "succeeded",
    ),
    "Durable alarm did not deliver the signed reply",
  );
  const jiraRaw = JSON.stringify({
    webhookEvent: "comment_created",
    issue: { key: issue, fields: { updated: "2026-10-07T10:00:00Z" } },
    comment: {
      id: "smoke-comment",
      author: { accountId: "engineer" },
      updated: "2026-10-07T10:00:00Z",
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Signed Jira response" }],
          },
        ],
      },
    },
  });
  const jiraSignature =
    "sha256=" +
    createHmac("sha256", vars.JIRA_WEBHOOK_SECRET)
      .update(jiraRaw)
      .digest("hex");
  assert.equal(
    (
      await fetch(base + "/events/jira", {
        method: "POST",
        headers: {
          "x-hub-signature": jiraSignature,
          "x-atlassian-webhook-identifier": "signed-jira-reply",
        },
        body: jiraRaw,
      })
    ).status,
    202,
  );
  for (let i = 0; i < 30; i++) {
    snapshot = await api("/api/state");
    if (
      snapshot.events.some(
        (e) => e.id === "signed-jira-reply" && e.status === "succeeded",
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(
    snapshot.events.some(
      (e) => e.id === "signed-jira-reply" && e.status === "succeeded",
    ),
  );
  const statusRaw = JSON.stringify({
    webhookEvent: "jira:issue_updated",
    issue: {
      key: issue,
      fields: { updated: "2026-10-07T10:01:00Z", status: { name: "Done" } },
    },
    user: { accountId: first.state.config.serviceActor },
    changelog: { items: [{ field: "status" }] },
  });
  const statusSig =
    "sha256=" +
    createHmac("sha256", vars.JIRA_WEBHOOK_SECRET)
      .update(statusRaw)
      .digest("hex");
  assert.equal(
    (
      await fetch(base + "/events/jira", {
        method: "POST",
        headers: {
          "x-hub-signature": statusSig,
          "x-atlassian-webhook-identifier": "signed-status-confirmation",
        },
        body: statusRaw,
      })
    ).status,
    202,
  );
  for (let i = 0; i < 30; i++) {
    snapshot = await api("/api/state");
    if (snapshot.links[0].status === "Done") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(
    snapshot.links[0].status,
    "Done",
    "Service-account transition confirmation was suppressed as an echo",
  );
  const wire = JSON.parse(readFileSync("fixtures/wire-payloads.json", "utf8"));
  const wireRoot = await api("/api/demo/payload", {
    source: "slack",
    payload: wire.slack_message,
  });
  assert.ok(
    wireRoot.state.events.some(
      (e) => e.id === "Ev_WIRE_ROOT" && e.status === "succeeded",
    ),
  );
  const wireFiles = await api("/api/demo/payload", {
    source: "slack",
    payload: wire.slack_file_reply,
  });
  const recorded = wireFiles.state.events.find((e) => e.id === "Ev_WIRE_FILE");
  assert.equal(recorded.status, "succeeded");
  assert.ok(!recorded.payload.text.includes("files-pri"));
  snapshot = wireFiles.state;
  const receipts = snapshot.effects.length;
  await running.stop();
  running = await start();
  const reopened = await api("/api/state");
  assert.ok(reopened.links.some((link) => link.issue === issue));
  assert.equal(reopened.effects.length, receipts);
  const duplicate = await api("/api/demo/event", { event });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state.effects.length, receipts);
  writeFileSync(
    ".data/local-verification.json",
    JSON.stringify(
      {
        runtime: "workerd",
        mode: "mock",
        checks: [
          "control_auth",
          "signed_slack_ingress",
          "signed_jira_ingress",
          "service_actor_status_confirmation",
          "durable_alarm_delivery",
          "restart_persistence",
          "duplicate_after_restart",
          "full_wire_payload_replay",
          "file_share_reply_contract",
        ],
        passed: true,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: 9,
      runtime: "workerd",
      outbound: "mock",
    }),
  );
} finally {
  if (running) await running.stop();
  if (relative(dataRoot, resolve(directory)).startsWith(".."))
    throw Error("Test cleanup escaped the owned data directory.");
  rmSync(directory, { recursive: true, force: true });
}
