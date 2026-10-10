import {
  DeliveryError,
  type DB,
  type SqlValue,
  type BridgeEvent,
  type Config,
  type Link,
  type Effect,
  type Adapter,
  type Receipt,
} from "./types.ts";
import { plan } from "./planner.ts";
import { validateEvent } from "./events.ts";
type EventRow = Record<string, SqlValue> & {
  id: string;
  payload: string;
  status: string;
  error: string | null;
  created: number;
};
type EffectRow = Record<string, SqlValue> & {
  key: string;
  event_id: string;
  payload: string;
  status: string;
  attempts: number;
  next_at: number;
  receipt: string | null;
  error: string | null;
};
type LinkRow = Record<string, SqlValue> & Link;
const unblocked = `NOT EXISTS (SELECT 1 FROM effects prior WHERE prior.rowid<e.rowid AND prior.status IN ('sending','uncertain','blocked','pending') AND (
 (json_extract(prior.payload,'$.thread') IS NOT NULL AND json_extract(prior.payload,'$.thread')=json_extract(e.payload,'$.thread')) OR
 (json_extract(prior.payload,'$.issue') IS NOT NULL AND json_extract(prior.payload,'$.issue')=json_extract(e.payload,'$.issue'))))`;
export class Journal {
  db: DB;
  config: Config;
  paused: boolean;
  constructor(db: DB, config: Config) {
    this.db = db;
    this.config = config;
    db.run(
      "CREATE TABLE IF NOT EXISTS bridge_config(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)",
    );
    const pinned = db.all("SELECT payload FROM bridge_config WHERE id=1")[0];
    this.paused = Boolean(pinned && pinned.payload !== JSON.stringify(config));
    if (!pinned)
      db.run("INSERT INTO bridge_config VALUES(1,?)", JSON.stringify(config));
    else this.config = JSON.parse(String(pinned.payload)) as Config;
    db.run(`CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,error TEXT,created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS links(thread TEXT PRIMARY KEY,issue TEXT NOT NULL UNIQUE,status TEXT NOT NULL,revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS effects(key TEXT PRIMARY KEY,event_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,receipt TEXT,error TEXT);
  CREATE INDEX IF NOT EXISTS effects_due ON effects(status,next_at);`);
    // Upgrade the early prototype's provider-specific tags without changing identities.
    db.run(
      "UPDATE events SET payload=json_set(payload,'$.origin','ticket') WHERE json_extract(payload,'$.origin')='jira'",
    );
    db.run(
      "UPDATE effects SET payload=json_set(payload,'$.kind','ticket.'||substr(kind,6)),kind='ticket.'||substr(kind,6) WHERE kind LIKE 'jira.%'",
    );
    // A completed external write without a persisted receipt cannot be retried safely.
    db.run(
      "UPDATE effects SET status='uncertain',error='Runtime interrupted before a receipt was committed' WHERE status='sending'",
    );
    db.run(
      "UPDATE events SET status='held',error='Reconcile interrupted delivery' WHERE id IN (SELECT event_id FROM effects WHERE status='uncertain')",
    );
  }
  async accept(event: BridgeEvent) {
    if (this.paused)
      throw Error(
        "Bridge configuration changed. Delivery is paused until its stored configuration is restored or migrated.",
      );
    event = validateEvent(event);
    const payload = JSON.stringify(event),
      hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(payload),
      );
    const fingerprint = Array.from(new Uint8Array(hash))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    return this.db.transaction(() => {
      const previous = this.db.all<
        Record<string, SqlValue> & { fingerprint: string; payload: string }
      >("SELECT fingerprint,payload FROM events WHERE id=?", event.id)[0];
      if (previous) {
        if (
          previous.fingerprint !== fingerprint &&
          JSON.stringify(validateEvent(JSON.parse(previous.payload))) !==
            payload
        )
          throw Error("Event ID conflicts with an earlier payload.");
        return { id: event.id, duplicate: true };
      }
      this.db.run(
        "INSERT INTO events(id,fingerprint,payload,status,created) VALUES(?,?,?,'queued',?)",
        event.id,
        fingerprint,
        payload,
        Date.now(),
      );
      return { id: event.id, duplicate: false };
    });
  }
  link(event: BridgeEvent): Link | null {
    return event.thread
      ? this.db.all<LinkRow>(
          "SELECT * FROM links WHERE thread=?",
          event.thread,
        )[0] || null
      : event.issue
        ? this.db.all<LinkRow>(
            "SELECT * FROM links WHERE issue=?",
            event.issue,
          )[0] || null
        : null;
  }
  prepare() {
    for (const row of this.db.all<EventRow>(
      `SELECT * FROM events e WHERE status='queued' OR (status='waiting' AND EXISTS (SELECT 1 FROM links l WHERE l.thread=json_extract(e.payload,'$.thread') OR l.issue=json_extract(e.payload,'$.issue'))) ORDER BY seq LIMIT 100`,
    )) {
      const event = validateEvent(JSON.parse(row.payload)),
        result = plan(event, this.link(event), this.config);
      this.db.transaction(() => {
        this.db.run(
          "UPDATE events SET status=?,error=? WHERE id=?",
          result.status === "ready" ? "running" : result.status,
          result.reason || null,
          event.id,
        );
        for (const [i, effect] of result.effects.entries())
          this.db.run(
            "INSERT OR IGNORE INTO effects(key,event_id,kind,payload,status) VALUES(?,?,?,?,'pending')",
            event.id + ":" + i,
            event.id,
            effect.kind,
            JSON.stringify(effect),
          );
      });
    }
  }
  finish(row: EffectRow, receipt: Receipt) {
    const effect = JSON.parse(row.payload) as Effect,
      event = this.db.all<EventRow>(
        "SELECT * FROM events WHERE id=?",
        row.event_id,
      )[0],
      source = validateEvent(JSON.parse(event.payload));
    if (!receipt.id || typeof receipt.id !== "string")
      throw Error("A verified provider receipt ID is required.");
    if (
      receipt.issue &&
      (typeof receipt.issue !== "string" ||
        receipt.issue.length > 128 ||
        /[\u0000-\u001f]/.test(receipt.issue))
    )
      throw Error("Invalid opaque ticket identifier in receipt.");
    if (receipt.thread && !/^\d{10,16}\.\d{1,6}$/.test(receipt.thread))
      throw Error("Receipt has an invalid Slack timestamp.");
    if (effect.issue && receipt.issue && effect.issue !== receipt.issue)
      throw Error("Receipt belongs to a different issue.");
    this.db.transaction(() => {
      if (effect.kind === "ticket.create") {
        if (!receipt.issue || !effect.thread)
          throw Error("Create receipt needs a ticket ID and Slack thread.");
        this.db.run(
          "INSERT INTO links VALUES(?,?,?,?)",
          effect.thread,
          receipt.issue,
          "Open",
          0,
        );
        const ack: Effect = {
          kind: "slack.post",
          thread: effect.thread,
          issue: receipt.issue,
          text: `Created ${receipt.issue}. Replies in this thread will sync with the ticket.`,
          eventId: source.id,
        };
        this.db.run(
          "INSERT OR IGNORE INTO effects(key,event_id,kind,payload,status) VALUES(?,?,?,?,'pending')",
          source.id + ":ack",
          source.id,
          ack.kind,
          JSON.stringify(ack),
        );
      } else if (effect.kind === "slack.post" && effect.root) {
        if (!receipt.thread || !effect.issue)
          throw Error("Create receipt needs a thread timestamp and ticket ID.");
        this.db.run(
          "INSERT INTO links VALUES(?,?,?,?)",
          receipt.thread,
          effect.issue,
          "Open",
          0,
        );
      }
      if (source.kind === "status" && source.issue)
        this.db.run(
          "UPDATE links SET status=?,revision=? WHERE issue=?",
          source.status || "Unknown",
          source.revision,
          source.issue,
        );
      this.db.run(
        "UPDATE effects SET status='succeeded',receipt=?,error=NULL WHERE key=?",
        JSON.stringify(receipt),
        row.key,
      );
      if (
        !this.db.all(
          "SELECT key FROM effects WHERE event_id=? AND status!='succeeded'",
          row.event_id,
        ).length
      )
        this.db.run(
          "UPDATE events SET status='succeeded',error=NULL WHERE id=?",
          row.event_id,
        );
    });
  }
  async pump(adapter: Adapter, now = Date.now()) {
    if (this.paused)
      throw Error(
        "Configuration drift: pending effects will not be delivered with a different bridge configuration.",
      );
    this.prepare();
    for (let count = 0; count < 25; count++) {
      const row = this.db.all<EffectRow>(
        `SELECT e.* FROM effects e WHERE e.status='pending' AND e.next_at<=? AND ${unblocked} ORDER BY e.rowid LIMIT 1`,
        now,
      )[0];
      if (!row) break;
      const source = validateEvent(
        JSON.parse(
          this.db.all<EventRow>(
            "SELECT * FROM events WHERE id=?",
            row.event_id,
          )[0].payload,
        ),
      );
      const action = JSON.parse(row.payload) as Effect;
      if (
        source.kind === "root" &&
        (action.kind === "ticket.create" || action.root) &&
        this.link(source)
      ) {
        this.db.transaction(() => {
          this.db.run(
            "UPDATE effects SET status='succeeded',receipt=? WHERE key=?",
            JSON.stringify({ id: "root-already-linked" }),
            row.key,
          );
          this.db.run(
            "UPDATE events SET status='ignored',error='Root already linked' WHERE id=?",
            row.event_id,
          );
        });
        continue;
      }
      if (
        source.kind === "status" &&
        source.revision <= (this.link(source)?.revision || 0)
      ) {
        this.db.transaction(() => {
          this.db.run(
            "UPDATE effects SET status='succeeded',receipt=? WHERE key=?",
            JSON.stringify({ id: "stale-event-suppressed" }),
            row.key,
          );
          this.db.run(
            "UPDATE events SET status='ignored',error='Stale ticket status event' WHERE id=?",
            row.event_id,
          );
        });
        continue;
      }
      this.db.run(
        "UPDATE effects SET status='sending',attempts=attempts+1 WHERE key=?",
        row.key,
      );
      try {
        const receipt = await adapter.execute(
          JSON.parse(row.payload) as Effect,
        );
        this.finish(row, receipt);
        this.prepare();
      } catch (error) {
        const delivery =
          error instanceof DeliveryError
            ? error
            : new DeliveryError(
                "Receipt could not be committed. Verify the destination before continuing.",
                "uncertain",
              );
        const retry = delivery.kind === "retry" && row.attempts < 4;
        const message =
          delivery.kind === "retry" && !retry
            ? "Retry budget exhausted after five attempts. Inspect the destination before resuming."
            : delivery.message;
        this.db.transaction(() => {
          this.db.run(
            "UPDATE effects SET status=?,error=?,next_at=? WHERE key=?",
            retry
              ? "pending"
              : delivery.kind === "uncertain"
                ? "uncertain"
                : "blocked",
            message,
            retry ? Date.now() + Math.max(1000, delivery.delay) : 0,
            row.key,
          );
          this.db.run(
            "UPDATE events SET status=?,error=? WHERE id=?",
            retry ? "retrying" : "held",
            message,
            row.event_id,
          );
        });
      }
    }
  }
  nextDue() {
    return (
      this.db.all<Record<string, SqlValue> & { due: number | null }>(
        `SELECT MIN(e.next_at) AS due FROM effects e WHERE e.status='pending' AND ${unblocked}`,
      )[0]?.due ?? null
    );
  }
  reconcile(key: string, receipt: Receipt) {
    const row = this.db.all<EffectRow>(
      "SELECT * FROM effects WHERE key=? AND status='uncertain'",
      key,
    )[0];
    if (!row) throw Error("Only uncertain effects can be reconciled.");
    this.finish(row, receipt);
  }
  snapshot() {
    return {
      mode: this.config.mode,
      configuration_paused: this.paused,
      links: this.db.all<LinkRow>(
        "SELECT * FROM links ORDER BY rowid DESC LIMIT 100",
      ),
      events: this.db
        .all<EventRow>(
          "SELECT id,payload,status,error,created FROM events ORDER BY seq DESC LIMIT 100",
        )
        .map((r) => ({ ...r, payload: JSON.parse(r.payload) as BridgeEvent })),
      effects: this.db
        .all<EffectRow>("SELECT * FROM effects ORDER BY rowid DESC LIMIT 200")
        .map((r) => ({
          ...r,
          payload: JSON.parse(r.payload) as Effect,
          receipt: r.receipt ? (JSON.parse(r.receipt) as Receipt) : null,
        })),
    };
  }
}
