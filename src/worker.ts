import { DurableObject } from "cloudflare:workers";
import { Journal } from "./journal.ts";
import { MockAdapter, LiveAdapter, boundedText } from "./adapters.ts";
import { validSlack, validJira } from "./auth.ts";
import { slackEvent, jiraEvent, validateEvent } from "./events.ts";
import {
  record,
  text,
  type Config,
  type DB,
  type SqlValue,
  type BridgeEvent,
  type Receipt,
} from "./types.ts";

function configuration(env: Env): Config {
  const cfg: Config = {
    mode: String(env.MODE) === "live" ? "live" : "mock",
    team: env.SLACK_TEAM_ID,
    channel: env.SLACK_CHANNEL_ID,
    project: env.JIRA_PROJECT,
    issueType: env.JIRA_ISSUE_TYPE,
    doneTransition: env.JIRA_DONE_TRANSITION,
    serviceActor: env.JIRA_SERVICE_ACCOUNT_ID,
  };
  if (
    !/^[A-Z][A-Z0-9_]*$/.test(cfg.project) ||
    !cfg.team ||
    !cfg.channel ||
    !cfg.serviceActor
  )
    throw Error("Complete the bridge configuration.");
  if (cfg.mode === "live") {
    const site = new URL(env.JIRA_BASE_URL);
    if (
      site.protocol !== "https:" ||
      !site.hostname.endsWith(".atlassian.net") ||
      site.username ||
      site.password ||
      site.port
    )
      throw Error("Configure the Jira Cloud site before enabling live mode.");
    cfg.ticketSite = site.origin;
  }
  return cfg;
}
export class TicketBridge extends DurableObject<Env> {
  journal: Journal;
  mock: MockAdapter;
  config: Config;
  private inFlight: Promise<void> | null = null;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = configuration(env);
    const db: DB = {
      all: <T extends Record<string, SqlValue>>(
        query: string,
        ...params: SqlValue[]
      ): T[] => this.ctx.storage.sql.exec<T>(query, ...params).toArray(),
      run: (query, ...params) => {
        this.ctx.storage.sql.exec(query, ...params);
      },
      transaction: (fn) => this.ctx.storage.transactionSync(fn),
    };
    this.journal = new Journal(db, this.config);
    this.mock = new MockAdapter(db, this.config);
  }
  async accept(event: BridgeEvent) {
    const result = await this.journal.accept(event);
    await this.schedule();
    return result;
  }
  private async schedule() {
    const due = this.journal.nextDue(),
      hasQueued = this.journal.db.all(
        "SELECT id FROM events WHERE status='queued' LIMIT 1",
      ).length;
    const next = hasQueued
      ? Date.now() + 50
      : due === null
        ? null
        : Math.max(Date.now() + 50, due);
    if (next !== null) {
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null || next < existing)
        await this.ctx.storage.setAlarm(next);
    }
  }
  async pump() {
    if (this.inFlight) return this.inFlight;
    const work = this.journal.pump(
      this.config.mode === "mock"
        ? this.mock
        : new LiveAdapter(this.config, {
            slackToken: this.env.SLACK_BOT_TOKEN,
            jiraBase: this.env.JIRA_BASE_URL,
            jiraEmail: this.env.JIRA_EMAIL,
            jiraToken: this.env.JIRA_API_TOKEN,
          }),
    );
    this.inFlight = work;
    try {
      await work;
    } finally {
      this.inFlight = null;
      await this.schedule();
    }
  }
  async alarm() {
    if (this.journal.paused) return;
    await this.pump();
  }
  state() {
    return {
      ...this.journal.snapshot(),
      config: this.journal.config,
      remote: this.config.mode === "mock" ? this.mock.receipts() : [],
    };
  }
  async reconcile(key: string, receipt: Receipt) {
    this.journal.reconcile(key, receipt);
    await this.pump();
    return this.state();
  }
  async simulateFailure(kind: string) {
    if (this.config.mode !== "mock")
      throw Error("Simulation is disabled in live mode.");
    this.mock.fail(kind);
    return { ok: true };
  }
}
function equal(a: string, b: string) {
  const encoder = new TextEncoder(),
    x = encoder.encode(a),
    y = encoder.encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}
function authorized(request: Request, env: Env) {
  const token = env.ADMIN_TOKEN;
  if (!token || token.length < 24) return false;
  const bearer = request.headers.get("authorization") || "",
    cookie =
      request.headers
        .get("cookie")
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("tb_session="))
        ?.slice(11) || "";
  return equal(bearer, "Bearer " + token) || equal(cookie, token);
}
const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname,
      cfg = configuration(env),
      bridge = env.BRIDGES.getByName(
        `${cfg.mode}:${cfg.team}:${cfg.channel}:${cfg.project}`,
      );
    try {
      if (path.startsWith("/events/")) {
        if (request.method !== "POST")
          return json({ error: "POST required" }, 405);
        const raw = await boundedText(new Response(request.body));
        if (path === "/events/slack") {
          if (!(await validSlack(request, raw, env.SLACK_SIGNING_SECRET)))
            return json({ error: "Invalid Slack signature or timestamp" }, 401);
          const body = record(JSON.parse(raw));
          if (body.type === "url_verification")
            return json({ challenge: text(body.challenge) });
          const result = await bridge.accept(slackEvent(body, cfg));
          return json(result, 202);
        }
        if (path === "/events/jira") {
          if (!(await validJira(request, raw, env.JIRA_WEBHOOK_SECRET)))
            return json({ error: "Invalid Jira webhook signature" }, 401);
          const result = await bridge.accept(
            jiraEvent(
              JSON.parse(raw),
              cfg,
              request.headers.get("x-atlassian-webhook-identifier") ||
                undefined,
            ),
          );
          return json(result, 202);
        }
        return json({ error: "Unknown event source" }, 404);
      }
      if (!path.startsWith("/api/")) {
        const response = await env.ASSETS.fetch(request),
          headers = new Headers(response.headers);
        headers.set(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
        headers.set("Referrer-Policy", "no-referrer");
        headers.set("X-Content-Type-Options", "nosniff");
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      }
      if (
        request.method !== "GET" &&
        request.headers.get("origin") &&
        request.headers.get("origin") !== url.origin
      )
        return json({ error: "Same-origin request required" }, 403);
      if (path === "/api/session" && request.method === "POST") {
        const body = record(
          JSON.parse(await boundedText(new Response(request.body))),
        );
        if (
          !env.ADMIN_TOKEN ||
          env.ADMIN_TOKEN.length < 24 ||
          !equal(text(body.token, 200), env.ADMIN_TOKEN)
        )
          return json({ error: "Incorrect control token" }, 401);
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Set-Cookie": `tb_session=${env.ADMIN_TOKEN}; HttpOnly; SameSite=Strict; Path=/${url.protocol === "https:" ? "; Secure" : ""}`,
          },
        });
      }
      if (!authorized(request, env))
        return json({ error: "Sign in with the control token" }, 401);
      if (path === "/api/state" && request.method === "GET")
        return json(await bridge.state());
      const body =
        request.method === "GET"
          ? {}
          : record(JSON.parse(await boundedText(new Response(request.body))));
      if (path === "/api/demo/event" && request.method === "POST") {
        if (cfg.mode !== "mock")
          return json(
            { error: "Demo controls are disabled in live mode" },
            409,
          );
        const event = validateEvent(body.event);
        const result = await bridge.accept(event);
        await bridge.pump();
        return json({ ...result, state: await bridge.state() });
      }
      if (path === "/api/demo/failure" && request.method === "POST")
        return json(await bridge.simulateFailure(text(body.kind, 100)));
      if (path === "/api/demo/payload" && request.method === "POST") {
        if (cfg.mode !== "mock")
          return json(
            { error: "Payload replay is disabled in live mode" },
            409,
          );
        const event =
          body.source === "slack"
            ? slackEvent(body.payload, cfg)
            : body.source === "jira"
              ? jiraEvent(
                  body.payload,
                  cfg,
                  text(body.delivery_id, 200) || undefined,
                )
              : null;
        if (!event)
          return json({ error: "Choose Slack or Jira payload source" }, 400);
        const result = await bridge.accept(event);
        await bridge.pump();
        return json({ ...result, state: await bridge.state() });
      }
      if (path === "/api/reconcile" && request.method === "POST") {
        const receipt = record(body.receipt);
        return json(
          await bridge.reconcile(text(body.key, 300), {
            ...(typeof receipt.issue === "string"
              ? { issue: receipt.issue }
              : {}),
            ...(typeof receipt.thread === "string"
              ? { thread: receipt.thread }
              : {}),
            ...(typeof receipt.id === "string" ? { id: receipt.id } : {}),
          }),
        );
      }
      if (path === "/api/session" && request.method === "DELETE")
        return new Response("{}", {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie":
              "tb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          },
        });
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Request failed" },
        400,
      );
    }
  },
} satisfies ExportedHandler<Env>;
