import {
  DeliveryError,
  record,
  text,
  type Effect,
  type Receipt,
  type Adapter,
  type Config,
  type DB,
} from "./types.ts";
import { toAdf } from "./events.ts";
export interface Credentials {
  slackToken: string;
  jiraBase: string;
  jiraEmail: string;
  jiraToken: string;
}
export function requestFor(
  effect: Effect,
  cfg: Config,
  credentials: Credentials,
) {
  if (effect.kind === "slack.post")
    return {
      url: "https://slack.com/api/chat.postMessage",
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.slackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: cfg.channel,
        ...(!effect.root ? { thread_ts: effect.thread } : {}),
        text: effect.text
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;"),
        unfurl_links: false,
        unfurl_media: false,
        metadata: {
          event_type: "threadbridge",
          event_payload: { origin_event: effect.eventId },
        },
      }),
    };
  const base = new URL(credentials.jiraBase);
  if (cfg.ticketSite && base.origin !== cfg.ticketSite)
    throw new DeliveryError(
      "Jira site differs from the journal configuration.",
      "blocked",
    );
  if (
    base.protocol !== "https:" ||
    !base.hostname.endsWith(".atlassian.net") ||
    base.username ||
    base.password ||
    base.port ||
    base.search
  )
    throw new DeliveryError("Configure an HTTPS Jira Cloud site.", "blocked");
  const issue = encodeURIComponent(effect.issue || ""),
    headers = {
      Authorization:
        "Basic " + btoa(credentials.jiraEmail + ":" + credentials.jiraToken),
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  const origin = {
    key: "threadbridge.origin",
    value: {
      event_id: effect.eventId,
      thread: effect.thread,
      channel: cfg.channel,
    },
  };
  if (effect.kind === "ticket.create")
    return {
      url: base.origin + "/rest/api/3/issue",
      method: "POST",
      headers,
      body: JSON.stringify({
        fields: {
          project: { key: cfg.project },
          issuetype: { name: cfg.issueType },
          summary:
            effect.text.split("\n")[0].slice(0, 255) || "Slack support request",
          description: toAdf(effect.text),
        },
        properties: [origin],
      }),
    };
  if (effect.kind === "ticket.comment")
    return {
      url: base.origin + `/rest/api/3/issue/${issue}/comment`,
      method: "POST",
      headers,
      body: JSON.stringify({ body: toAdf(effect.text), properties: [origin] }),
    };
  return {
    url: base.origin + `/rest/api/3/issue/${issue}/transitions`,
    method: "POST",
    headers,
    body: JSON.stringify({ transition: { id: effect.transition } }),
  };
}
export async function boundedText(response: Response, max = 128 * 1024) {
  if (!response.body) return "";
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) {
        await reader.cancel();
        throw Error("Payload exceeds 128 KB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(bytes);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}
export class LiveAdapter implements Adapter {
  cfg: Config;
  credentials: Credentials;
  constructor(cfg: Config, credentials: Credentials) {
    this.cfg = cfg;
    this.credentials = credentials;
  }
  async execute(effect: Effect): Promise<Receipt> {
    const credentials = this.credentials;
    if (
      effect.kind === "slack.post"
        ? !credentials.slackToken
        : !credentials.jiraEmail ||
          !credentials.jiraToken ||
          !credentials.jiraBase
    )
      throw new DeliveryError(
        "Required API credentials are missing.",
        "blocked",
      );
    const request = requestFor(effect, this.cfg, credentials);
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new DeliveryError(
        "No delivery receipt. The destination may have applied this write.",
        "uncertain",
      );
    }
    if (response.status === 429) {
      await response.body?.cancel();
      const wait = Number(response.headers.get("retry-after"));
      throw new DeliveryError(
        "Destination rate limit. Scheduled for a safe retry.",
        "retry",
        Math.min(
          3600000,
          Math.max(1000, Number.isFinite(wait) ? wait * 1000 : 30000),
        ),
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DeliveryError(
        `Destination returned HTTP ${response.status}. Verify before redelivery.`,
        "uncertain",
      );
    }
    if (effect.kind === "ticket.transition" && response.status === 204)
      return { issue: effect.issue || undefined, id: "transition-accepted" };
    let data: Record<string, unknown>;
    try {
      data = record(JSON.parse(await boundedText(response)));
    } catch {
      throw new DeliveryError(
        "Unreadable response after sending a write.",
        "uncertain",
      );
    }
    if (effect.kind === "slack.post") {
      if (data.ok !== true)
        throw new DeliveryError(
          "Slack rejected the operation: " +
            text(data.error, 80).replace(/[^a-z_]/g, ""),
          "blocked",
        );
      if (!/^\d{10,16}\.\d{1,6}$/.test(text(data.ts)))
        throw new DeliveryError(
          "Slack receipt has no valid timestamp.",
          "uncertain",
        );
      return { thread: text(data.ts), id: text(data.ts) };
    }
    if (
      effect.kind === "ticket.create" &&
      !new RegExp("^" + this.cfg.project + "-[0-9]+$").test(text(data.key))
    )
      throw new DeliveryError("Jira receipt has no issue key.", "uncertain");
    if (effect.kind === "ticket.comment" && !text(data.id))
      throw new DeliveryError("Jira receipt has no comment ID.", "uncertain");
    return {
      issue: text(data.key) || effect.issue || undefined,
      id: text(data.id),
    };
  }
}
export class MockAdapter implements Adapter {
  db: DB;
  cfg: Config;
  constructor(db: DB, cfg: Config) {
    this.db = db;
    this.cfg = cfg;
    db.run(
      "CREATE TABLE IF NOT EXISTS mock_remote(key TEXT PRIMARY KEY,kind TEXT NOT NULL,receipt TEXT NOT NULL,request TEXT NOT NULL,created INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS mock_fault(id INTEGER PRIMARY KEY CHECK(id=1),kind TEXT NOT NULL);",
    );
    db.run(
      "UPDATE mock_remote SET key=substr(key,1,length(key)-length(kind))||'ticket.'||substr(kind,6),kind='ticket.'||substr(kind,6) WHERE kind LIKE 'jira.%'",
    );
    if (
      !db
        .all("PRAGMA table_info(mock_remote)")
        .some((r) => r.name === "created")
    )
      db.run(
        "ALTER TABLE mock_remote ADD COLUMN created INTEGER NOT NULL DEFAULT 0",
      );
    db.run(
      "UPDATE mock_remote SET created=COALESCE((SELECT created FROM events WHERE mock_remote.key LIKE events.id||':%' LIMIT 1),0) WHERE created=0",
    );
  }
  fail(kind: string) {
    if (!["rate_limit", "timeout_after_write"].includes(kind))
      throw Error("Unknown simulation fault.");
    this.db.run(
      "INSERT INTO mock_fault VALUES(1,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind",
      kind,
    );
  }
  async execute(effect: Effect): Promise<Receipt> {
    const fault = this.db.all("SELECT kind FROM mock_fault WHERE id=1")[0]
      ?.kind;
    this.db.run("DELETE FROM mock_fault WHERE id=1");
    if (fault === "rate_limit")
      throw new DeliveryError(
        "Simulated provider rate limit. No write was applied.",
        "retry",
        1000,
      );
    const key = effect.eventId + ":" + effect.kind,
      previous = this.db.all(
        "SELECT receipt FROM mock_remote WHERE key=?",
        key,
      )[0];
    let receipt: Receipt;
    if (previous) receipt = JSON.parse(String(previous.receipt)) as Receipt;
    else {
      const count =
        Number(this.db.all("SELECT COUNT(*) AS n FROM mock_remote")[0].n) + 1;
      receipt =
        effect.kind === "ticket.create"
          ? { issue: `${this.cfg.project}-${count}`, id: String(10000 + count) }
          : effect.kind === "slack.post"
            ? {
                thread: `${1700000000 + count}.000001`,
                id: `${1700000000 + count}.000001`,
              }
            : { issue: effect.issue || undefined, id: String(10000 + count) };
      const request = requestFor(effect, this.cfg, {
        slackToken: "[mock-token]",
        jiraBase: "https://example.atlassian.net",
        jiraEmail: "demo@example.test",
        jiraToken: "[mock-token]",
      });
      request.headers.Authorization = "[redacted]";
      this.db.run(
        "INSERT INTO mock_remote(key,kind,receipt,request,created) VALUES(?,?,?,?,?)",
        key,
        effect.kind,
        JSON.stringify(receipt),
        JSON.stringify(request),
        Date.now(),
      );
    }
    if (fault === "timeout_after_write")
      throw new DeliveryError(
        "Simulated timeout after the provider applied the write. Reconcile its receipt.",
        "uncertain",
      );
    return receipt;
  }
  receipts() {
    return this.db
      .all(
        "SELECT key,kind,receipt,request,created FROM mock_remote ORDER BY rowid DESC LIMIT 100",
      )
      .map((r) => ({
        ...r,
        receipt: JSON.parse(String(r.receipt)) as Receipt,
        request: JSON.parse(String(r.request)) as Record<string, unknown>,
      }));
  }
}
