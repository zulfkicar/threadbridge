export const escape = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function queueItems(state) {
  const items = state.links.map((link) => {
    const events = state.events
      .filter(
        (e) =>
          e.payload.thread === link.thread || e.payload.issue === link.issue,
      )
      .sort((a, b) => a.created - b.created);
    const held = events.filter((e) =>
      ["held", "retrying", "waiting"].includes(e.status),
    );
    return {
      key: link.thread,
      link,
      events,
      title:
        events
          .find((e) => e.payload.kind === "root")
          ?.payload.text.split("\n")[0] || link.issue,
      status: held.length
        ? "attention"
        : link.status === "Done"
          ? "done"
          : "open",
      latest: events.at(-1)?.created || 0,
      held: held.length,
    };
  });
  for (const e of state.events)
    if (
      ["held", "waiting"].includes(e.status) &&
      !items.some((item) => item.events.some((x) => x.id === e.id))
    )
      items.push({
        key: "event:" + e.id,
        link: null,
        events: [e],
        title: e.payload.text.split("\n")[0] || "Unlinked source event",
        status: "attention",
        latest: e.created,
        held: 1,
      });
  return items.sort((a, b) => b.latest - a.latest);
}
export function timeline(item, state) {
  if (!item)
    return '<div class="canvas-empty"><span class="empty-mark">↔</span><h2>The conversation starts with an event.</h2><p>Replay a Slack request or a Jira issue. Its identity link and delivery receipts appear here.</p><button class="primary" data-action="compose">Replay source event</button></div>';
  return `<div class="conversation-heading"><div class="conversation-kicker">${escape(item.link?.issue || "Awaiting link")} <span>${escape(item.link?.status || "Held for review")}</span></div><h1>${escape(item.title)}</h1><div class="identity-line"><span># ${escape(state.config.channel)}</span><span>↔</span><code>${escape(item.link?.issue || "Ticket not linked")}</code></div></div><div class="conversation-timeline">${item.events
    .map((e) => {
      const effects = state.effects.filter((x) => x.event_id === e.id),
        from = e.payload.origin === "slack" ? "Slack" : "Jira",
        target = from === "Slack" ? "Jira" : "Slack";
      const note =
        e.payload.kind === "status"
          ? `Status changed to ${e.payload.status}`
          : e.payload.kind === "reaction"
            ? `Reaction: ${e.payload.reaction}`
            : e.payload.text || e.error || e.payload.reason || "Source event";
      return `<article class="timeline-entry ${e.status === "held" ? "needs-attention" : ""}"><div class="timeline-avatar ${from.toLowerCase()}">${from === "Slack" ? "#" : "◇"}</div><div class="timeline-message"><div class="message-meta"><strong>${from === "Slack" ? "Slack member" : "Jira contributor"}</strong><code>${escape(e.payload.actor)}</code><time>${new Date(e.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><p>${escape(note)}</p><div class="delivery-line"><span class="delivery-dot ${escape(e.status)}"></span><span>${e.status === "succeeded" ? `Delivered to ${target}` : escape(e.status)}</span><span>${effects.filter((x) => x.status === "succeeded").length} receipts</span><button data-event="${escape(e.id)}">${e.status === "held" ? "Review hold" : "Inspect delivery"} ↗</button></div></div></article>`;
    })
    .join("")}</div>`;
}
export function connectionStrip(state) {
  return `<div class="route-strip"><span class="route-service"><b>#</b> Slack <small>${escape(state.config.channel)}</small></span><span class="route-wire">──────── ⇄ ────────</span><span class="route-service"><b>◇</b> Jira <small>${escape(state.config.project)}</small></span><span class="route-mode">${state.mode === "mock" ? "Mock adapters" : "Live adapters"}</span></div>`;
}
