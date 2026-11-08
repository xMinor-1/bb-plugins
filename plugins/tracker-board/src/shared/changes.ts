// A change to the tracker, as the panel and the agent ask for it. The server checks
// each one against the issue as it is now and describes it before anything is sent.
import { z } from "zod";
import { LIMITS } from "./limits";

const key = z.string().min(1).max(60);
const label = z.string().min(1).max(LIMITS.label);

export const changeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status"), key, to: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("assignee"), key, to: z.string().min(1).max(200).nullable() }).strict(),
  z.object({ kind: z.literal("priority"), key, to: z.string().min(1).max(100) }).strict(),
  z
    .object({ kind: z.literal("labels"), key, add: z.array(label).max(LIMITS.labels).default([]), remove: z.array(label).max(LIMITS.labels).default([]) })
    .strict(),
  z.object({ kind: z.literal("parent"), key, to: key.nullable() }).strict(),
  z.object({ kind: z.literal("summary"), key, to: z.string().min(1).max(LIMITS.summary) }).strict(),
  z.object({ kind: z.literal("description"), key, to: z.string().max(LIMITS.description) }).strict(),
  z.object({ kind: z.literal("comment"), key, text: z.string().min(1).max(LIMITS.comment) }).strict(),
  z
    .object({
      kind: z.literal("create"),
      /** Lets later changes of the same batch refer to this issue as their parent. */
      ref: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/),
      parentKey: key.nullable().default(null),
      parentRef: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/).nullable().default(null),
      /** Defaults to the parent's queue. */
      queue: z.string().max(60).nullable().default(null),
      summary: z.string().min(1).max(LIMITS.summary),
      type: z.string().max(100).default(""),
      priority: z.string().max(100).default(""),
      /** A person's id, `@me` or `@parent`; empty for nobody. */
      assignee: z.string().max(200).default(""),
      labels: z.array(label).max(LIMITS.labels).default([]),
      components: z.array(z.string().min(1).max(200)).max(20).default([]),
      description: z.string().max(LIMITS.description).default(""),
      template: z.string().max(16).nullable().default(null),
    })
    .strict(),
]);
export type Change = z.infer<typeof changeSchema>;
export type ChangeInput = z.input<typeof changeSchema>;

/** Why a change is skipped. The panel words each code; the agent gets English. */
export type SkipReason =
  | "same"
  | "noIssue"
  | "notSupported"
  | "selfParent"
  | "cycle"
  | "noLabels"
  | "unknownStatus"
  | "unknownPerson"
  | "noParent"
  | "duplicate";

export interface PlannedChange {
  id: string;
  change: Change;
  /** The issue's key, or the new issue's summary for a create. */
  key: string | null;
  title: string;
  ok: boolean;
  skip: SkipReason | null;
  from: string | null;
  to: string | null;
  /** The change that puts the issue back as it was; null when there is none (a comment, a new issue). */
  undo?: Change | null;
}

export interface ChangeResult {
  id: string;
  ok: boolean;
  /** The created issue's key. */
  key: string | null;
  code: string | null;
  detail: string | null;
}

export const SKIP_TEXT: Record<SkipReason, string> = {
  same: "already so",
  noIssue: "no such issue",
  notSupported: "the tracker configuration cannot make this change",
  selfParent: "an issue cannot be its own parent",
  cycle: "the new parent is below this issue",
  noLabels: "nothing to add or remove",
  unknownStatus: "no such status",
  unknownPerson: "no such person",
  noParent: "the parent is not found",
  duplicate: "the same change is in the list twice",
};
