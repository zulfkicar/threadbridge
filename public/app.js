import { queueItems, timeline, connectionStrip } from "./presentation.js";
const app = document.querySelector("#app"),
  dialog = document.querySelector("#dialog");
let state,
  view = "conversation",
  selectedThread,
  source = "slack",
  queueFilter = "all",
  queueSearch = "",
  lastEvent,
  noticeTimer;
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const pill = (v, label = v) =>
  `<span class="pill ${esc(v)}">${esc(label)}</span>`;
const pretty = (v) => JSON.stringify(v, null, 2);
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch("/api" + path, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) login();
    throw Error(result.error || "Request failed");
  }
  return result;
}
function notice(message) {
  const n = document.querySelector("#notice");
  n.textContent = message;
  n.className = "visible";
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (n.className = ""), 6000);
}
function login() {
  app.innerHTML = `<main class="login"><form id="login" class="panel"><div class="brand"><span class="mark">↔</span>Threadbridge</div><div class="eyebrow">Slack ↔ Jira · self-hosted</div><h1>Open the bridge console.</h1><p>Inspect linked conversations, deliveries and recovery. Your journal retains the links and delivery evidence.</p><label for="token">Control token</label><input id="token" name="token" type="password" required autocomplete="current-password"><p>Use ADMIN_TOKEN from your local .dev.vars file.</p><button class="primary">Sign in</button></form></main>`;
}
async function refresh() {
  state = await api("/state");
  if (!queueItems(state).some((l) => l.key === selectedThread))
    selectedThread = queueItems(state)[0]?.key;
  render();
}
function render() {
  const items = queueItems(state);
  if (!items.some((i) => i.key === selectedThread))
    selectedThread = items[0]?.key;
  const shown = items.filter(
      (i) =>
        (queueFilter === "all" || i.status === queueFilter) &&
        (i.title + " " + (i.link?.issue || ""))
          .toLowerCase()
          .includes(queueSearch.toLowerCase()),
    ),
    held = state.events.filter((e) => e.status === "held").length;
  if (!shown.some((i) => i.key === selectedThread))
    selectedThread = shown[0]?.key;
  const item = shown.find((i) => i.key === selectedThread);
  app.innerHTML = `<header class="app-header"><div class="brand"><span class="mark">↔</span><span>threadbridge<small>conversation operations</small></span></div><div class="header-center">${esc(state.config.channel)}<span>/</span>${esc(state.config.project)}</div><div class="actions">${pill(state.mode === "mock" ? "waiting" : "linked", state.mode === "mock" ? "Replay workspace" : "Live providers")}<button class="quiet" data-action="setup">Setup</button><button class="quiet" data-action="logout">Sign out</button></div></header><div class="app-workspace"><aside class="queue-rail"><div class="rail-title"><h2>Conversations</h2><button data-action="compose" aria-label="Replay a new source event">＋</button></div><input id="queue-search" placeholder="Find a conversation…" aria-label="Find a conversation" value="${esc(queueSearch)}"><div class="queue-filters">${[
    ["all", "All"],
    ["attention", "Attention"],
    ["done", "Done"],
  ]
    .map(
      ([id, label]) =>
        `<button data-filter="${id}" class="${queueFilter === id ? "active" : ""}">${label}<small>${items.filter((i) => id === "all" || i.status === id).length}</small></button>`,
    )
    .join(
      "",
    )}</div><div class="queue-list">${shown.map((i) => `<button class="queue-item ${i.key === selectedThread ? "selected" : ""}" data-thread="${esc(i.key)}"><span class="queue-item-top"><code>${esc(i.link?.issue || "UNLINKED")}</code><span class="queue-state ${i.status}">${i.status === "attention" ? "!" : i.status === "done" ? "✓" : "○"}</span></span><strong>${esc(i.title)}</strong><span class="queue-preview">${esc(i.events.at(-1)?.payload.text.slice(0, 64) || i.link?.status || "Waiting for a link")}</span><span class="queue-item-bottom">${i.events.length} events <small>${i.held ? i.held + " need review" : i.status}</small></span></button>`).join("") || '<div class="rail-empty">No conversations match this view.</div>'}</div><div class="rail-footer"><span class="pulse-dot"></span>Local journal <code>${state.events.length} events</code></div></aside><main class="workspace-main"><div class="workspace-toolbar"><div class="view-tabs">${[
    ["conversation", "Conversation"],
    ["compare", "Side by side"],
    ["ledger", "Delivery journal"],
    ["architecture", "System notes"],
  ]
    .map(
      ([id, label]) =>
        `<button data-view="${id}" class="${view === id ? "active" : ""}">${label}</button>`,
    )
    .join(
      "",
    )}</div><button class="quiet" data-action="refresh" aria-label="Refresh journal">↻</button></div>${connectionStrip(state)}${state.configuration_paused ? '<div class="attention-banner">Configuration changed. Delivery is paused until the stored configuration is restored or migrated.</div>' : ""}${held ? `<button class="attention-banner" data-filter="attention"><strong>${held} held event${held === 1 ? "" : "s"}</strong><span>Review delivery evidence before continuing →</span></button>` : ""}<section class="workspace-canvas">${view === "conversation" ? (item || items.length === 0 ? timeline(item, state) : `<div class="canvas-empty"><span class="empty-mark">✓</span><h2>${queueFilter === "attention" ? "No deliveries need review." : "No conversations match this view."}</h2><p>Adjust the search or switch back to all conversations.</p><button data-filter="all" data-clear-search="true">All conversations</button></div>`) : view === "compare" ? conversation(item?.link) : view === "ledger" ? ledger() : architecture()}</section><footer class="workspace-foot"><span>${state.effects.filter((e) => e.status === "succeeded").length} recorded delivery receipts</span><button data-action="compose">Replay source event ↗</button><span>${state.mode === "mock" ? "No external writes" : "Signed ingress enabled"}</span></footer></main></div>`;
}
function compose() {
  const link = state.links.find((l) => l.thread === selectedThread),
    mock = state.mode === "mock";
  if (!mock) {
    notice("Live messages arrive through the signed webhook endpoints.");
    return;
  }
  show(
    `<form id="event-form"><div class="eyebrow">Replay tools / mock providers</div><h2>Replay a source event</h2><p>This runs the actual journal and provider request builder. No external ticket or message is sent.</p><div class="composer-fields"><label for="origin">Source</label><select id="origin" name="source"><option value="slack" ${source === "slack" ? "selected" : ""}>Slack</option><option value="ticket" ${source === "ticket" ? "selected" : ""}>Jira</option></select><label for="kind">Action</label><select id="kind" name="kind"><option value="root">Create ${source === "slack" ? "a ticket" : "a Slack thread"}</option>${link ? `<option value="reply">Reply to ${esc(link.issue)}</option>${source === "ticket" ? '<option value="status">Confirm Done status</option>' : '<option value="reaction">Request Done with a reaction</option>'}` : ""}</select><label for="message">Message</label><textarea id="message" name="text" required placeholder="Write a representative request or reply…">Report exports fail when I select a custom date range.</textarea></div><details class="raw-replay"><summary>Replay a raw Slack or Jira payload</summary><label for="raw-source">Payload source</label><select id="raw-source"><option value="slack">Slack Events API</option><option value="jira">Jira webhook</option></select><label for="raw-payload">Redacted JSON payload</label><textarea id="raw-payload" spellcheck="false" placeholder='{"event_id": "…", "event": {…}}'></textarea><button type="button" data-action="raw-replay">Replay raw payload</button><p>Use the team, channel and project configured for this replay workspace.</p></details><div class="replay-tools"><h3>Delivery conditions</h3><button type="button" data-fault="rate_limit">Next call: rate limit</button><button type="button" data-fault="timeout_after_write">Next call: lost receipt</button><button type="button" data-action="replay" ${!lastEvent ? "disabled" : ""}>Replay last event</button></div><div class="actions"><button type="button" data-action="close">Cancel</button><button class="primary">Replay event →</button></div></form>`,
  );
}
function message(author, text, tag = "") {
  return `<div class="message"><div class="avatar">${esc(author.slice(0, 2).toUpperCase())}</div><div class="content"><strong>${esc(author)}</strong><small>${esc(tag)}</small><p>${esc(text)}</p></div></div>`;
}
function conversation(link) {
  if (!link)
    return `<div class="pair"><div class="lane"><div class="lane-head"><span class="service"><span class="serviceicon">#</span>Slack</span><small>${esc(state.config.channel)}</small></div><div class="empty"><h3>A conversation starts here.</h3>Send a Slack request to create a Jira issue, or start from Jira to create a Slack thread.</div></div><div class="connector">⇄</div><div class="lane"><div class="lane-head"><span class="service"><span class="serviceicon jira">◇</span>Jira</span><small>${esc(state.config.project)}</small></div><div class="empty"><h3>The bridge keeps the link.</h3>Replies use the stored ticket/thread mapping. Bot echoes are filtered before delivery.</div></div></div>`;
  const events = state.events
    .filter(
      (e) => e.payload.thread === link.thread || e.payload.issue === link.issue,
    )
    .slice()
    .reverse();
  const receipts = state.remote
    .filter((r) => {
      const effect = state.effects.find(
        (e) => e.payload.eventId + ":" + e.kind === r.key,
      )?.payload;
      return (
        effect && (effect.thread === link.thread || effect.issue === link.issue)
      );
    })
    .slice()
    .reverse();
  const slack = [];
  const jira = [];
  for (const e of events)
    if (
      e.payload.kind !== "ignored" &&
      e.payload.kind !== "reaction" &&
      e.payload.kind !== "status"
    ) {
      const text = e.payload.text;
      if (e.payload.origin === "slack")
        slack.push({
          at: e.created,
          html: message("You", text, "Slack event"),
        });
      else
        jira.push({
          at: e.created,
          html: message("Engineer", text, "Jira event"),
        });
    }
  for (const r of receipts) {
    const request = r.request,
      body = JSON.parse(request.body || "{}");
    if (r.kind === "slack.post")
      slack.push({
        at: r.created,
        html: message(
          "Threadbridge",
          (body.text || "")
            .replaceAll("&lt;", "<")
            .replaceAll("&gt;", ">")
            .replaceAll("&amp;", "&"),
          "Mirrored",
        ),
      });
    else if (r.kind === "ticket.create")
      jira.push({
        at: r.created,
        html: message(
          "Threadbridge",
          body.fields?.summary || "Ticket created",
          "Created from Slack",
        ),
      });
    else if (r.kind === "ticket.comment")
      jira.push({
        at: r.created,
        html: message(
          "Threadbridge",
          body.body?.content
            ?.map((p) => p.content?.map((x) => x.text || "").join(""))
            .join("\n") || "",
          "Mirrored",
        ),
      });
  }
  return `<div class="toolbar"><span>${pill("linked", "Linked")} <span class="muted">Replies follow this mapping</span></span><select id="thread-select" aria-label="Conversation">${state.links.map((l) => `<option value="${esc(l.thread)}" ${l.thread === link.thread ? "selected" : ""}>${esc(l.issue)} · ${esc(l.thread)}</option>`).join("")}</select></div><div class="pair"><div class="lane"><div class="lane-head"><span class="service"><span class="serviceicon">#</span>Slack</span><small>${esc(state.config.channel)}</small></div><div class="messages">${
    slack
      .sort((a, b) => a.at - b.at)
      .map((m) => m.html)
      .join("") || '<div class="empty">Waiting for a Slack message.</div>'
  }</div></div><div class="connector">⇄</div><div class="lane"><div class="lane-head"><span class="service"><span class="serviceicon jira">◇</span>Jira</span>${pill("linked", link.status)}</div><div class="ticket-title">${esc(link.issue)}</div><div class="ticket-meta">${esc(state.config.project)} / ${esc(state.config.issueType)} · status owned by Jira</div><div class="messages">${
    jira
      .sort((a, b) => a.at - b.at)
      .map((m) => m.html)
      .join("") || '<div class="empty">Issue linked. No comments yet.</div>'
  }</div></div></div><div class="link-strip"><span class="mono">${esc(link.thread)} ⇄ ${esc(link.issue)}</span><span>Mapping persists across restarts</span></div><div class="controls"><button data-view="ledger">Inspect delivery journal →</button></div>`;
}
function ledger() {
  return `<div class="ledger"><div class="ledger-header"><h2>Event inbox & delivery outbox</h2><span class="muted mono">Latest ${state.events.length}</span></div>${state.events.map((e) => `<div class="ledger-row"><span>${esc(e.payload.origin)} → ${e.payload.origin === "slack" ? "Jira" : "Slack"}</span><div class="event-name">${esc(e.payload.kind)} · ${esc(e.id.slice(0, 22))}<small>${esc(e.error || e.payload.text.slice(0, 80) || "Source event")}</small></div>${pill(e.status)}<button class="quiet" data-event="${esc(e.id)}" aria-label="Inspect ${esc(e.id)}">↗</button></div>`).join("") || '<div class="empty">No events received yet.</div>'}</div>`;
}
function architecture() {
  return `<section class="panel architecture"><div class="eyebrow">Delivery model</div><h2>Delivery model</h2><ol><li><strong>Verify and persist.</strong> Slack and Jira signatures are checked against the raw payload. Event IDs bind to a payload fingerprint. The receiver acknowledges after persistence, before API delivery.</li><li><strong>Find the identity link.</strong> A Slack thread timestamp and Jira issue key identify the same conversation. A reply arriving before its parent waits for that link.</li><li><strong>Plan the other side.</strong> The planner selects an adapter action. Jira ADF and Slack message metadata are built by the provider adapters. Mirrored events and bot echoes are ignored.</li><li><strong>Journal the write.</strong> A durable outbox records a sending state before the API request. Rate limits back off. Missing receipts become uncertain holds. Later writes to that conversation wait.</li><li><strong>Recover with evidence.</strong> A verified provider receipt resumes the chain. A completed write is reused, not sent again. Stale status events cannot regress the ticket.</li></ol><div class="help">Jira is the first ticket adapter. The planner, event journal and thread mapping are independent of Jira-specific HTTP calls, so a Modal or another ticket adapter can implement the same contract.</div><div class="divider"></div><h3>Boundaries</h3><p>Comments and status changes are supported. File binaries, message edits/deletes, internal-only Jira comments, multi-workspace OAuth onboarding and automatic reconciliation searches need further work. API-shaped mocks do not establish live API compatibility.</p></section>`;
}
function show(content) {
  dialog.innerHTML = content;
  dialog.showModal();
}
function inspect(id) {
  const e = state.events.find((e) => e.id === id),
    effects = state.effects.filter((x) => x.event_id === id);
  show(
    `<div class="eyebrow">Event ${esc(e.id)}</div><h2>Delivery details ${pill(e.status)}</h2><pre>${esc(pretty(e.payload))}</pre>${effects.map((x) => `<div class="detail-row"><h3>${esc(x.kind)} ${pill(x.status)}</h3>${x.error ? `<p>${esc(x.error)}</p>` : ""}<pre>${esc(pretty(x.receipt || x.payload))}</pre>${x.status === "uncertain" ? `<button data-reconcile="${esc(x.key)}">Record verified receipt</button>` : ""}</div>`).join("") || "<p>No provider action was planned.</p>"}<div class="actions"><button data-action="close">Close</button></div>`,
  );
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  try {
    if (b.dataset.thread) {
      selectedThread = b.dataset.thread;
      view = "conversation";
      render();
      return;
    }
    if (b.dataset.filter) {
      queueFilter = b.dataset.filter;
      if (b.dataset.clearSearch) queueSearch = "";
      render();
      return;
    }
    if (b.dataset.action === "compose") {
      compose();
      return;
    }
    if (b.dataset.action === "raw-replay") {
      b.disabled = true;
      const result = await api("/demo/payload", {
        source: document.querySelector("#raw-source").value,
        payload: JSON.parse(document.querySelector("#raw-payload").value),
      });
      state = result.state;
      selectedThread =
        queueItems(state).find((i) => i.events.some((e) => e.id === result.id))
          ?.key || selectedThread;
      dialog.close();
      render();
      notice("Raw payload normalized and journalled.");
      return;
    }
    if (b.dataset.view) {
      view = b.dataset.view;
      render();
      return;
    }
    if (b.dataset.event) {
      inspect(b.dataset.event);
      return;
    }
    if (b.dataset.fault) {
      await api("/demo/failure", { kind: b.dataset.fault });
      notice("Fault armed for the next provider call.");
      return;
    }
    if (b.dataset.reconcile) {
      const effect = state.effects.find((x) => x.key === b.dataset.reconcile),
        remote = state.remote.find(
          (r) => r.key === effect.payload.eventId + ":" + effect.kind,
        );
      show(
        `<form id="reconcile"><h2>Verify the provider receipt.</h2><p>The write may have completed. Verify the destination before recording its result. ${remote ? "The mock provider has a receipt for this operation." : ""}</p><input type="hidden" name="key" value="${esc(effect.key)}"><label for="receipt">Verified receipt · JSON</label><textarea id="receipt" name="receipt" required>${esc(pretty(remote?.receipt || { id: "", ...(effect.kind === "ticket.create" ? { issue: "" } : {}) }))}</textarea>${remote ? `<details><summary>Mock provider evidence</summary><pre>${esc(pretty(remote))}</pre></details>` : ""}<div class="actions"><button type="button" data-action="close">Cancel</button><button class="primary">Record & continue</button></div></form>`,
      );
      return;
    }
    if (b.dataset.action === "close") {
      dialog.close();
      return;
    }
    if (b.dataset.action === "refresh") {
      await refresh();
      return;
    }
    if (b.dataset.action === "logout") {
      await api("/session", {}, "DELETE");
      login();
      return;
    }
    if (b.dataset.action === "replay") {
      const result = await api("/demo/event", { event: lastEvent });
      state = result.state;
      render();
      notice(
        result.duplicate
          ? "Duplicate recognized. No new delivery planned."
          : "Event received.",
      );
      return;
    }
    if (b.dataset.action === "setup") {
      show(
        `<h2>Connect your own workspace.</h2><p>Local mode uses mock providers. For a live deployment, use fresh credentials and sandbox channels/projects first.</p><ol class="architecture"><li>Set Slack team/channel and Jira project/issue type in wrangler.jsonc. Configure the Jira Done transition ID and service account ID.</li><li>Set Worker secrets: ADMIN_TOKEN, SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, JIRA_WEBHOOK_SECRET, JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN.</li><li>Subscribe Slack to message.channels or message.groups and reaction_added. The bot needs chat:write and history access for the selected channel.</li><li>Register a signed Jira webhook for issue_created, issue_updated and comment_created, filtered to your project.</li><li>Switch MODE to live after sandbox checks. Mock and live journals are separate.</li></ol><pre>Slack: /events/slack\nJira: /events/jira\nNode 24 · npm install · npm run dev</pre><div class="actions"><button data-action="close">Close</button></div>`,
      );
      return;
    }
  } catch (error) {
    b.disabled = false;
    notice(error.message);
  }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "origin") {
    source = e.target.value;
    compose();
  }
  if (e.target.id === "thread-select") {
    selectedThread = e.target.value;
    render();
  }
  if (e.target.id === "kind")
    document.querySelector("#message").required = ![
      "status",
      "reaction",
    ].includes(e.target.value);
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target,
    data = new FormData(form),
    button = form.querySelector("button.primary");
  button.disabled = true;
  try {
    if (form.id === "login") {
      await api("/session", { token: data.get("token") });
      await refresh();
    }
    if (form.id === "reconcile") {
      state = await api("/reconcile", {
        key: data.get("key"),
        receipt: JSON.parse(data.get("receipt")),
      });
      dialog.close();
      render();
      notice("Verified receipt recorded. Completed writes were reused.");
    }
    if (form.id === "event-form") {
      const origin = data.get("source"),
        kind = data.get("kind"),
        link = state.links.find((l) => l.thread === selectedThread),
        now = Date.now();
      lastEvent = {
        id: crypto.randomUUID(),
        origin,
        kind,
        thread:
          origin === "slack"
            ? kind === "root"
              ? `${Math.floor(now / 1000)}.${String(now % 1000).padStart(6, "0")}`
              : link.thread
            : null,
        issue:
          origin === "ticket"
            ? kind === "root"
              ? state.config.project + "-" + (1000 + state.events.length)
              : link.issue
            : null,
        text: String(data.get("text")),
        actor: origin === "slack" ? "U_DEMO" : "demo-engineer",
        revision: now,
        ...(kind === "status" ? { status: "Done" } : {}),
        ...(kind === "reaction" ? { reaction: "white_check_mark" } : {}),
      };
      const result = await api("/demo/event", { event: lastEvent });
      state = result.state;
      if (kind === "root")
        selectedThread = state.links.find((l) =>
          origin === "slack"
            ? l.thread === lastEvent.thread
            : l.issue === lastEvent.issue,
        )?.thread;
      dialog.close();
      render();
      notice("Event persisted and processed by the Worker.");
    }
  } catch (error) {
    notice(error.message);
  } finally {
    button.disabled = false;
  }
});
refresh().catch((error) => notice(error.message));

let queueSearchTimer;
document.addEventListener("input", (e) => {
  if (e.target.id === "queue-search") {
    queueSearch = e.target.value;
    clearTimeout(queueSearchTimer);
    queueSearchTimer = setTimeout(() => {
      const caret = e.target.selectionStart;
      render();
      const field = document.querySelector("#queue-search");
      field.focus();
      field.setSelectionRange(caret, caret);
    }, 180);
  }
});
