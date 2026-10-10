import {
  type BridgeEvent,
  type Link,
  type Effect,
  type Config,
} from "./types.ts";
export type Plan = {
  status: "ignored" | "waiting" | "ready";
  reason?: string;
  effects: Effect[];
};
export function plan(event: BridgeEvent, link: Link | null, cfg: Config): Plan {
  if (event.kind === "ignored")
    return { status: "ignored", reason: event.reason, effects: [] };
  if (
    event.origin === "ticket" &&
    event.actor === cfg.serviceActor &&
    event.kind !== "status"
  )
    return { status: "ignored", reason: "Service actor echo", effects: [] };
  const effect = (
    kind: Effect["kind"],
    extra: Partial<Effect> = {},
  ): Effect => ({
    kind,
    thread: link?.thread || event.thread,
    issue: link?.issue || event.issue,
    text: event.text,
    eventId: event.id,
    ...extra,
  });
  if (event.kind === "root") {
    if (link)
      return {
        status: "ignored",
        reason: "Root is already linked",
        effects: [],
      };
    return {
      status: "ready",
      effects: [
        event.origin === "slack"
          ? effect("ticket.create")
          : effect("slack.post", { root: true }),
      ],
    };
  }
  if (!link)
    return {
      status: "waiting",
      reason: "The parent ticket/thread has not been linked yet",
      effects: [],
    };
  if (event.kind === "reply")
    return {
      status: "ready",
      effects: [
        effect(event.origin === "slack" ? "ticket.comment" : "slack.post"),
      ],
    };
  if (event.kind === "status") {
    if (event.revision <= link.revision)
      return {
        status: "ignored",
        reason: "Stale ticket status event",
        effects: [],
      };
    return {
      status: "ready",
      effects: [
        effect("slack.post", {
          text: `${link.issue} is now ${event.status || "updated"}.`,
        }),
      ],
    };
  }
  if (
    event.kind === "reaction" &&
    event.reaction === "white_check_mark" &&
    cfg.doneTransition
  )
    return {
      status: "ready",
      effects: [
        effect("ticket.transition", { transition: cfg.doneTransition }),
      ],
    };
  return {
    status: "ignored",
    reason: "Reaction has no configured action",
    effects: [],
  };
}
