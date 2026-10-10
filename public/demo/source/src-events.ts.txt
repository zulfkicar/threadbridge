import { record, text, type BridgeEvent, type Config } from "./types.ts";
const validTs = (v: unknown) =>
  typeof v === "string" && /^\d{10,16}\.\d{1,6}$/.test(v);
export function adfText(v: unknown): string {
  if (!v || typeof v !== "object") return typeof v === "string" ? v : "";
  const n = record(v),
    children = Array.isArray(n.content) ? n.content.map(adfText).join("") : "";
  if (n.type === "text") return text(n.text);
  if (n.type === "mention")
    return n.attrs
      ? text(record(n.attrs).text) || "@" + text(record(n.attrs).id)
      : "";
  if (n.type === "emoji")
    return n.attrs
      ? text(record(n.attrs).text || record(n.attrs).shortName)
      : "";
  if (n.type === "inlineCard") return n.attrs ? text(record(n.attrs).url) : "";
  if (n.type === "hardBreak") return "\n";
  return (
    children +
    (["paragraph", "heading", "listItem"].includes(String(n.type)) ? "\n" : "")
  );
}
export function toAdf(value: string) {
  return {
    type: "doc",
    version: 1,
    content: value.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}
export function slackEvent(body: unknown, cfg: Config): BridgeEvent {
  const outer = record(body),
    e = record(outer.event),
    id = text(outer.event_id, 200);
  if (
    !id ||
    text(outer.team_id) !== cfg.team ||
    text(e.channel || (e.item && record(e.item).channel)) !== cfg.channel
  )
    throw Error("Event does not belong to this configured bridge.");
  const rawTime =
    e.event_ts ||
    e.ts ||
    (typeof outer.event_time === "number"
      ? String(outer.event_time) + ".000000"
      : "");
  if (!validTs(rawTime)) throw Error("Invalid Slack event timestamp.");
  const [seconds, fraction] = String(rawTime).split("."),
    revision =
      Number(seconds) * 1000 + Number(fraction.padEnd(3, "0").slice(0, 3));
  if (!Number.isSafeInteger(revision) || revision <= 0)
    throw Error("Slack event time is outside the supported range.");
  const base = {
    id,
    origin: "slack" as const,
    actor: text(e.user, 100),
    revision,
    issue: null,
  };
  if (
    e.bot_id ||
    e.app_id ||
    (e.subtype &&
      !["file_share", "thread_broadcast"].includes(String(e.subtype))) ||
    (e.metadata && record(e.metadata).event_type === "threadbridge")
  )
    return {
      ...base,
      kind: "ignored",
      thread: null,
      text: "",
      reason: "Bot, mirrored or unsupported message subtype",
    };
  if (e.type === "reaction_added") {
    const item = record(e.item);
    if (!validTs(item.ts)) throw Error("Invalid Slack message timestamp.");
    return {
      ...base,
      kind: "reaction",
      thread: String(item.ts),
      reaction: text(e.reaction, 100),
      text: "",
    };
  }
  if (
    e.type !== "message" ||
    !validTs(e.ts) ||
    (e.thread_ts && !validTs(e.thread_ts))
  )
    throw Error("Unsupported Slack event.");
  if (typeof e.user !== "string" || !e.user)
    throw Error(
      "Expected a native Slack user ID. Enriched Zapier outputs require an explicit adapter.",
    );
  return {
    ...base,
    kind: e.thread_ts && e.thread_ts !== e.ts ? "reply" : "root",
    thread: String(e.thread_ts || e.ts),
    text: slackMessageText(e),
  };
}
function slackMessageText(e: Record<string, unknown>) {
  const lines = [text(e.text)];
  if (Array.isArray(e.files))
    for (const value of e.files.slice(0, 10)) {
      const file = record(value),
        title = text(file.title || file.name, 200) || "Attachment";
      const permalink = text(file.permalink, 2048);
      try {
        const url = new URL(permalink);
        if (
          url.protocol === "https:" &&
          (url.hostname === "slack.com" ||
            url.hostname.endsWith(".slack.com")) &&
          !url.username &&
          !url.password &&
          !url.search
        )
          lines.push(`Attachment: ${title} — ${url.href}`);
        else lines.push(`Attachment: ${title} (link not forwarded)`);
      } catch {
        lines.push(`Attachment: ${title} (no accessible permalink)`);
      }
    }
  return lines.filter(Boolean).join("\n").slice(0, 16000);
}
export function jiraEvent(
  body: unknown,
  cfg: Config,
  deliveryId?: string,
): BridgeEvent {
  const outer = record(body),
    issue = record(outer.issue),
    fields = record(issue.fields),
    key = text(issue.key, 100);
  if (!new RegExp("^" + cfg.project + "-[0-9]+$").test(key))
    throw Error("Issue does not belong to the configured project.");
  const hook = text(outer.webhookEvent),
    comment = outer.comment ? record(outer.comment) : null;
  const revision =
    Date.parse(text(comment?.updated || fields.updated)) ||
    Number(outer.timestamp);
  if (!Number.isFinite(revision) || revision <= 0)
    throw Error("Event needs a valid source timestamp.");
  const actor = comment?.author
    ? text(record(comment.author).accountId, 100)
    : outer.user
      ? text(record(outer.user).accountId, 100)
      : "";
  const id =
    deliveryId ||
    `${hook}:${key}:${comment ? text(comment.id, 100) : revision}:${revision}`;
  const base = {
    id: id.slice(0, 200),
    origin: "ticket" as const,
    issue: key,
    thread: null,
    actor,
    revision,
  };
  const properties = Array.isArray(comment?.properties)
    ? comment.properties
    : [];
  if (
    comment &&
    (comment.visibility ||
      comment.jsdPublic === false ||
      properties.some((p) => {
        const property = record(p);
        return (
          property.key === "sd.public.comment" &&
          property.value &&
          record(property.value).internal === true
        );
      }))
  )
    return {
      ...base,
      kind: "ignored",
      text: "",
      reason: "Restricted or internal comment is not mirrored",
    };
  if (
    (actor === cfg.serviceActor && hook !== "jira:issue_updated") ||
    properties.some((p) => record(p).key === "threadbridge.origin")
  )
    return {
      ...base,
      kind: "ignored",
      text: "",
      reason: "Bridge-authored ticket event",
    };
  if (hook === "comment_created" && comment)
    return {
      ...base,
      kind: "reply",
      text: adfText(comment.body).trim().slice(0, 16000),
    };
  if (hook === "jira:issue_created")
    return {
      ...base,
      kind: "root",
      text: `${text(fields.summary, 255)}\n${adfText(fields.description).trim()}`.trim(),
    };
  if (hook === "jira:issue_updated") {
    const changes = outer.changelog ? record(outer.changelog).items : [];
    if (
      Array.isArray(changes) &&
      changes.some((x) => record(x).field === "status")
    )
      return {
        ...base,
        kind: "status",
        text: "",
        status: fields.status
          ? text(record(fields.status).name, 100)
          : "Unknown",
      };
  }
  return {
    ...base,
    kind: "ignored",
    text: "",
    reason: "No supported comment or status change",
  };
}
export function validateEvent(v: unknown): BridgeEvent {
  const e = record(v);
  if (
    typeof e.id !== "string" ||
    !e.id ||
    e.id.length > 200 ||
    !["slack", "ticket"].includes(String(e.origin)) ||
    !["root", "reply", "status", "reaction", "ignored"].includes(
      String(e.kind),
    ) ||
    typeof e.text !== "string" ||
    e.text.length > 16000 ||
    typeof e.actor !== "string" ||
    typeof e.revision !== "number" ||
    !Number.isFinite(e.revision) ||
    e.revision <= 0
  )
    throw Error("Invalid canonical event.");
  if (e.thread !== null && !validTs(e.thread))
    throw Error("Invalid thread reference.");
  if (
    e.issue !== null &&
    (typeof e.issue !== "string" ||
      !e.issue ||
      e.issue.length > 128 ||
      /[\u0000-\u001f]/.test(e.issue))
  )
    throw Error("Invalid issue reference.");
  const kind = e.kind;
  if (
    kind !== "root" &&
    kind !== "reply" &&
    kind !== "status" &&
    kind !== "reaction" &&
    kind !== "ignored"
  )
    throw Error("Invalid event kind.");
  if (e.origin === "slack" && kind !== "ignored" && !e.thread)
    throw Error("Slack events require a thread reference.");
  if (e.origin === "ticket" && kind !== "ignored" && !e.issue)
    throw Error("Ticket events require an issue reference.");
  return {
    id: e.id,
    origin: e.origin === "slack" ? "slack" : "ticket",
    kind,
    thread: typeof e.thread === "string" ? e.thread : null,
    issue: typeof e.issue === "string" ? e.issue : null,
    text: e.text,
    actor: e.actor,
    revision: e.revision,
    ...(typeof e.status === "string" ? { status: text(e.status, 100) } : {}),
    ...(typeof e.reaction === "string"
      ? { reaction: text(e.reaction, 100) }
      : {}),
    ...(typeof e.reason === "string" ? { reason: text(e.reason, 200) } : {}),
  };
}
