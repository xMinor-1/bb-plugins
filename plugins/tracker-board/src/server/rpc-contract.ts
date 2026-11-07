// The panel's RPC methods. The panel imports only the type of this contract.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { failureCodeSchema, keyStatusSchema } from "../../contract";
import { changeSchema, type ChangeResult, type PlannedChange } from "../shared/changes";
import type { Comment, Issue, Person } from "../shared/model";
import { exportSchema, prefsPatchSchema, sourceSchema, type Prefs } from "../shared/prefs";
import type { Category } from "../shared/profile";
import type { Bundle, Template } from "../shared/templates";

export interface StatusView {
  key: string;
  name: string;
  category: Category;
}

export interface ConfigView {
  name: string;
  /** Why the plugin cannot work yet; null when it can. */
  problem: string | null;
  address: string | null;
  webUrl: string | null;
  keyHelp: string | null;
  statuses: StatusView[];
  types: { key: string; name: string }[];
  priorities: { key: string; name: string }[];
  /** Build templates first, then the person's own. */
  templates: Template[];
  bundles: Bundle[];
  composition: string[];
  allowQuery: boolean;
  /** The build's shared boards, on top of "My boards" until the person orders them. */
  defaultBoards: z.infer<typeof sourceSchema>[];
  can: {
    create: boolean;
    status: boolean;
    assign: boolean;
    priority: boolean;
    labels: boolean;
    parent: boolean;
    summary: boolean;
    comments: boolean;
    addComment: boolean;
    people: boolean;
    components: boolean;
    mine: boolean;
    /** Queues can be found by name. */
    queues: boolean;
  };
  /** Whether any agent may use the tracker tools. */
  agentsAllowed: boolean;
  /** The build's default for confirming agent changes; the person's prefs may differ. */
  confirmDefault: boolean;
}

export interface BoardView {
  source: z.infer<typeof sourceSchema>;
  title: string;
  root: Issue | null;
  issues: Issue[];
  /** Parents of the board's issues that live elsewhere: for paths and epic tags, not cards. */
  parents: Issue[];
  truncated: boolean;
  loadedAt: number;
  statuses: StatusView[];
  people: Person[];
  me: Person | null;
}

export interface IssueView {
  issue: Issue;
  comments: Comment[] | null;
  components: string[] | null;
  /** Direct children, when the tracker can list them by parent. */
  children: Issue[] | null;
  /** The issue's parents up to the top. */
  parents: Issue[];
}

export interface QueueView {
  key: string;
  name: string;
}

/** What "What are you interested in" offers first: from the person's own tasks. */
export interface Suggestions {
  queues: (QueueView & { count: number })[];
  epics: { issue: Issue; count: number }[];
}

/** One change an agent applied without a form, and what its undo did. */
export interface AppliedItemView {
  planned: Omit<PlannedChange, "undo">;
  ok: boolean;
  /** The created issue's key. */
  key: string | null;
  code: string | null;
  canUndo: boolean;
  undo: "undone" | "changedSince" | "failed" | null;
  undoCode: string | null;
}

/** A batch the agent applied at once: the `::tracker-changes` card in its reply. */
export interface AppliedView {
  tracker: string;
  at: number;
  items: AppliedItemView[];
  undoneAt: number | null;
}

const appliedInput = z.object({ id: z.string().regex(/^u_[0-9a-f]{12}$/), threadId: z.string().min(1).max(200) }).strict();

export interface ChatView {
  threadId: string | null;
  /** bb's personal project: a chat about tasks needs no code checkout. */
  projectId: string | null;
  hostId: string | null;
}

const custom = <T>() => z.custom<T>(() => true);

const changes = z.array(changeSchema).min(1).max(200);

export const rpcContract = defineRpcContract({
  config: { input: z.null(), output: custom<ConfigView>() },
  machines: {
    input: z.null(),
    output: z.object({ machines: z.array(z.object({ id: z.string(), name: z.string(), connected: z.boolean() }).strict()), current: z.string().nullable() }).strict(),
  },
  setMachine: { input: z.object({ hostId: z.string().min(1).max(200) }).strict(), output: z.null() },
  keyStatus: { input: z.null(), output: keyStatusSchema.extend({ hostId: z.string().nullable() }) },
  saveKey: {
    input: z.object({ key: z.string().min(1).max(4000) }).strict(),
    output: z.object({ ok: z.boolean(), code: z.union([failureCodeSchema, z.literal("badAnswer"), z.literal("notConfigured")]).nullable(), me: custom<Person | null>() }).strict(),
  },
  checkKey: {
    input: z.null(),
    output: z.object({ ok: z.boolean(), code: z.union([failureCodeSchema, z.literal("badAnswer"), z.literal("notConfigured")]).nullable(), me: custom<Person | null>() }).strict(),
  },
  forgetKey: { input: z.null(), output: keyStatusSchema },
  prefs: { input: z.null(), output: custom<Prefs>() },
  setPrefs: { input: prefsPatchSchema, output: custom<Prefs>() },
  importPrefs: { input: z.object({ file: exportSchema }).strict(), output: custom<Prefs>() },
  board: { input: z.object({ source: sourceSchema }).strict(), output: custom<BoardView>() },
  issue: { input: z.object({ key: z.string().min(1).max(60) }).strict(), output: custom<IssueView>() },
  /** An issue with everything under it, for a parent's composition in the task panel. Saves nothing. */
  tree: { input: z.object({ key: z.string().min(1).max(60) }).strict(), output: custom<{ issues: Issue[]; truncated: boolean }>() },
  find: { input: z.object({ text: z.string().max(300) }).strict(), output: custom<{ issues: Issue[] }>() },
  people: { input: z.object({ text: z.string().max(200) }).strict(), output: custom<Person[]>() },
  queues: { input: z.object({ text: z.string().max(200) }).strict(), output: custom<{ queues: QueueView[] }>() },
  suggestBoards: { input: z.null(), output: custom<Suggestions>() },
  appliedChanges: { input: appliedInput, output: custom<AppliedView>() },
  undoApplied: { input: appliedInput, output: custom<AppliedView>() },
  preview: { input: z.object({ changes }).strict(), output: custom<PlannedChange[]>() },
  apply: {
    input: z.object({ changes, approve: z.array(z.string().max(10)).max(200) }).strict(),
    output: custom<{ planned: PlannedChange[]; results: ChangeResult[] }>(),
  },
  chat: { input: z.null(), output: custom<ChatView>() },
  startChat: { input: z.object({ request: z.record(z.string(), z.unknown()) }).strict(), output: z.object({ threadId: z.string() }).strict() },
  setChat: { input: z.object({ threadId: z.string().max(100).nullable() }).strict(), output: z.null() },
});
