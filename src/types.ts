export type Origin = "slack" | "ticket";
export type Kind = "root" | "reply" | "status" | "reaction" | "ignored";
export interface BridgeEvent {
  id: string;
  origin: Origin;
  kind: Kind;
  thread: string | null;
  issue: string | null;
  text: string;
  actor: string;
  revision: number;
  status?: string;
  reaction?: string;
  reason?: string;
}
export type EffectKind =
  "ticket.create" | "ticket.comment" | "ticket.transition" | "slack.post";
export interface Effect {
  kind: EffectKind;
  thread: string | null;
  issue: string | null;
  text: string;
  transition?: string;
  root?: boolean;
  eventId: string;
}
export interface Receipt {
  issue?: string;
  thread?: string;
  id?: string;
}
export interface Config {
  mode: "mock" | "live";
  team: string;
  channel: string;
  project: string;
  issueType: string;
  doneTransition: string;
  serviceActor: string;
  ticketSite?: string;
}
export interface Link {
  thread: string;
  issue: string;
  status: string;
  revision: number;
}
export type SqlValue = string | number | null;
export interface DB {
  all<T extends Record<string, SqlValue>>(
    query: string,
    ...params: SqlValue[]
  ): T[];
  run(query: string, ...params: SqlValue[]): void;
  transaction<T>(fn: () => T): T;
}
export interface Adapter {
  execute(effect: Effect): Promise<Receipt>;
}
export class DeliveryError extends Error {
  kind: "retry" | "uncertain" | "blocked";
  delay: number;
  constructor(
    message: string,
    kind: "retry" | "uncertain" | "blocked",
    delay = 0,
  ) {
    super(message);
    this.kind = kind;
    this.delay = delay;
  }
}
export function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("Expected an object.");
  return v as Record<string, unknown>;
}
export function text(v: unknown, max = 16000): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}
