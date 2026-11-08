// `bb doc-review` — how agents read review comments and report back.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliRegistration,
} from "@get-bb/plugin-sdk";
import type { Exchange } from "./exchange.js";
import { isWindowsPath, normalizeAbsolute } from "./files.js";
import { CLI_NAME, strokeLines } from "./message.js";
import type { CommentWithDoc, DocRow, ReviewStore } from "./store.js";
import { anchorLabel, anchorQuote, truncate, type CommentReply, type CommentStatus } from "./types.js";

const STATUSES = ["draft", "sent", "replied", "resolved"] as const;
const LIST_LIMIT = 200;
const NOTE_MAX = 2000;

function replyLine(reply: CommentReply, max: number): string {
  const agent = reply.name ? `agent of ${reply.name}` : "agent";
  const who =
    reply.author === "agent"
      ? reply.outcome === "resolved"
        ? `${agent} (resolved)`
        : agent
      : reply.name
        ? reply.name
        : reply.sentAt === null
          ? "user (draft)"
          : "user";
  return `${who}: ${max === Infinity ? reply.body : truncate(reply.body, max)}`;
}

function formatComment(comment: CommentWithDoc): string {
  const quote = anchorQuote(comment.anchor);
  const lines = [
    `${comment.id}  #${comment.seq}  [${comment.status}]  ${anchorLabel(comment.anchor, comment.doc.kind)}`,
  ];
  if (quote) lines.push(`  quote: «${truncate(quote, 300)}»`);
  if (comment.author) lines.push(`  by: ${comment.author}${comment.originFile ? `, on ${comment.originFile}` : ""}`);
  lines.push(`  comment: ${truncate(comment.body, 1000)}`);
  for (const reply of comment.thread) lines.push(`  ${replyLine(reply, 500)}`);
  return lines.join("\n");
}

function groupByFile(comments: CommentWithDoc[]): string {
  const groups = new Map<string, CommentWithDoc[]>();
  for (const comment of comments) {
    const key = comment.doc.hostId
      ? `${comment.doc.absPath} (host ${comment.doc.hostId})`
      : comment.doc.absPath;
    groups.set(key, [...(groups.get(key) ?? []), comment]);
  }
  return [...groups.entries()]
    .map(([file, items]) => [`${file}`, ...items.map(formatComment)].join("\n"))
    .join("\n\n");
}

function publicComment(comment: CommentWithDoc) {
  return {
    id: comment.id,
    seq: comment.seq,
    status: comment.status,
    file: comment.doc.absPath,
    hostId: comment.doc.hostId,
    kind: comment.doc.kind,
    location: anchorLabel(comment.anchor, comment.doc.kind),
    anchor: comment.anchor,
    body: comment.body,
    by: comment.author,
    originFile: comment.originFile,
    agentNote: comment.agentNote,
    thread: comment.thread.map((reply) => ({
      author: reply.author,
      name: reply.name,
      body: reply.body,
      outcome: reply.outcome,
      draft: reply.author === "user" && reply.sentAt === null,
    })),
    sentThreadId: comment.sentThreadId,
  };
}

/** Writes `bytes` to `file`, or to "name 2.pdf", "name 3.pdf", … when it is taken; returns the path used. */
async function writeBeside(file: string, bytes: Uint8Array): Promise<string> {
  const stem = file.replace(/\.pdf$/i, "");
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? file : `${stem} ${n}.pdf`;
    try {
      await writeFile(candidate, bytes, { flag: "wx" });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new PluginCliError(`Too many exports next to ${file}.`, { code: "file_exists", hint: "Pass --out." });
}

export function reviewCli(options: {
  bb: BbPluginApi;
  store: ReviewStore;
  onChanged: (docIds: string[]) => void;
  exchange: Exchange;
  /** The document for a file on the bb server's machine; throws when there is no such file. */
  openDoc: (absPath: string, hostId: string | null) => Promise<DocRow>;
  readSigner: () => Promise<string | null>;
}): PluginCliRegistration {
  const { store, onChanged, exchange } = options;

  const absolute = (file: string, cwd: string | undefined) => {
    if (isWindowsPath(file)) return normalizeAbsolute(file);
    if (path.posix.isAbsolute(file)) return path.posix.normalize(file);
    // A bb server running on Windows reports a Windows working directory.
    if (cwd && isWindowsPath(cwd)) return normalizeAbsolute(path.win32.resolve(cwd, file));
    return path.posix.resolve(cwd ?? "/", file);
  };

  async function docAt(file: string, cwd: string | undefined): Promise<DocRow> {
    try {
      return await options.openDoc(absolute(file, cwd), null);
    } catch (error) {
      throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "file_not_found" });
    }
  }

  function requireComment(id: string): CommentWithDoc {
    const comment = store.getComment(id.trim());
    if (!comment) {
      throw new PluginCliError(`No review comment with id ${id}.`, {
        code: "comment_not_found",
        hint: `Run \`bb ${CLI_NAME} list\` to see ids.`,
      });
    }
    return comment;
  }

  function checkNote(note: string | undefined, required: boolean): string | null {
    const trimmed = note?.trim() ?? "";
    if (!trimmed) {
      if (required) {
        throw new PluginCliError("--note is required.", {
          code: "missing_required",
          hint: 'Add --note "…" with the answer or reason.',
        });
      }
      return null;
    }
    if (trimmed.length > NOTE_MAX) {
      throw new PluginCliError(`--note is longer than ${NOTE_MAX} characters.`, {
        code: "invalid_value",
      });
    }
    return trimmed;
  }

  return defineCli({
    name: CLI_NAME,
    summary: "Read review comments left on files in the Doc Review panel and report fixes",
    description:
      "Comments are left on Markdown, PDF, Word, PowerPoint, Excel, and HTML files in bb's Doc Review panel and handed to an agent. Close each handled comment with `resolve`, or answer with `reply` when it cannot be applied. Notes go into the comment's thread, where the user can answer back; a follow-up arrives with the thread so far. `export` writes a PDF with the comments in it to send to someone, and `import` brings in the comments of such a PDF from another reviewer.",
    commands: {
      list: cliCommand({
        summary: "List review comments (default: the ones sent to this thread and still waiting)",
        options: {
          file: {
            type: "string",
            description: "Only comments on this file (absolute, or relative to the current directory)",
            aliases: ["path"],
          },
          status: {
            type: "enum",
            values: [...STATUSES, "all"],
            default: "sent",
            description: "Filter by status: draft, sent, replied, resolved, or all",
          },
          "all-threads": {
            type: "boolean",
            description: "Include comments sent to other threads (default: only this thread's when run inside one)",
          },
          json: { type: "boolean", description: "Emit machine-readable JSON" },
        },
        async run(input, ctx) {
          const statuses: CommentStatus[] =
            input.options.status === "all" ? [...STATUSES] : [input.options.status as CommentStatus];
          let docIds: string[] | undefined;
          if (input.options.file) {
            docIds = store.findDocsByPath(absolute(input.options.file, ctx.cwd)).map((doc) => doc.id);
          }
          const restrictToThread =
            !input.options["all-threads"] &&
            !input.options.file &&
            input.options.status === "sent" &&
            ctx.threadId
              ? ctx.threadId
              : null;
          const comments = store.queryComments({
            statuses,
            threadId: restrictToThread,
            ...(docIds ? { docIds } : {}),
            limit: LIST_LIMIT,
          });
          if (input.options.json) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ comments: comments.map(publicComment) }),
            };
          }
          if (comments.length === 0) {
            return {
              exitCode: 0,
              stdout: restrictToThread
                ? "No comments are waiting for this thread. Add --all-threads to see every thread."
                : "No matching comments.",
            };
          }
          const more = comments.length === LIST_LIMIT ? `\n\n(showing the first ${LIST_LIMIT})` : "";
          return { exitCode: 0, stdout: groupByFile(comments) + more };
        },
      }),
      show: cliCommand({
        summary: "Show one comment in full",
        positionals: [{ name: "id", description: "Comment id, like c_ab12cd34", required: true }],
        options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
        async run(input) {
          const comment = requireComment(input.positionals.id);
          if (input.options.json) {
            return { exitCode: 0, stdout: JSON.stringify(publicComment(comment)) };
          }
          const quote = anchorQuote(comment.anchor);
          const text = [
            `${comment.id}  #${comment.seq}  [${comment.status}]`,
            `file: ${comment.doc.absPath}`,
            `location: ${anchorLabel(comment.anchor, comment.doc.kind)}`,
            ...(quote ? [`quote: «${quote}»`] : []),
            ...(comment.author ? [`by: ${comment.author}${comment.originFile ? `, on ${comment.originFile}` : ""}`] : []),
            ...strokeLines(comment),
            `comment: ${comment.body}`,
            ...comment.thread.map((reply) => replyLine(reply, Infinity)),
          ].join("\n");
          return { exitCode: 0, stdout: text };
        },
      }),
      resolve: cliCommand({
        summary: "Mark comments as done, with a one-line note on what changed",
        positionals: [
          { name: "ids", description: "One or more comment ids", required: true, variadic: true },
        ],
        options: {
          note: {
            type: "string",
            description: `What you changed, shown to the user next to the comment (max ${NOTE_MAX} chars)`,
            aliases: ["message"],
            short: "m",
            stdin: true,
          },
          json: { type: "boolean", description: "Emit machine-readable JSON" },
        },
        async run(input) {
          const note = checkNote(input.options.note, false);
          const comments = input.positionals.ids.map(requireComment);
          const resolved = comments.map((comment) => store.resolve(comment.id, note));
          onChanged([...new Set(comments.map((comment) => comment.doc.id))]);
          if (input.options.json) {
            return { exitCode: 0, stdout: JSON.stringify({ resolved: resolved.map((c) => c.id) }) };
          }
          return {
            exitCode: 0,
            stdout: `Resolved ${resolved.map((c) => `${c.id} (#${c.seq})`).join(", ")}.`,
          };
        },
      }),
      export: cliCommand({
        summary:
          "Write a PDF of a PDF, Word, or PowerPoint file with its review comments in it, to send to someone; Doc Review in another bb imports them from it",
        positionals: [{ name: "file", description: "The reviewed file (absolute, or relative to the current directory)", required: true }],
        options: {
          out: {
            type: "string",
            description: 'Where to write the PDF (default: next to the file, as "<name> (comments).pdf", numbered when taken)',
          },
          as: { type: "string", description: "The name to sign the comments with (default: the one last used in the panel)" },
          force: { type: "boolean", description: "Replace the --out file if it exists" },
          json: { type: "boolean", description: "Emit machine-readable JSON" },
        },
        async run(input, ctx) {
          const doc = await docAt(input.positionals.file, ctx.cwd);
          const signer = input.options.as?.trim() || (await options.readSigner());
          const exported = await exchange.exportPdf(doc, signer).catch((error: unknown) => {
            throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "export_failed" });
          });
          let out: string;
          if (input.options.out) {
            out = absolute(input.options.out, ctx.cwd);
            if (out === doc.absPath) throw new PluginCliError("--out would overwrite the reviewed file.", { code: "invalid_value" });
            await writeFile(out, exported.bytes, { flag: input.options.force ? "w" : "wx" }).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "EEXIST") throw error;
              throw new PluginCliError(`${out} exists.`, { code: "file_exists", hint: "Add --force to replace it." });
            });
          } else {
            // Next to the file, never over another: a PDF someone sent back may sit there under the same name.
            out = await writeBeside(path.posix.join(path.posix.dirname(doc.absPath), exported.name), exported.bytes);
          }
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ path: out, comments: exported.count }) };
          return { exitCode: 0, stdout: `Wrote ${out} with ${exported.count} comment${exported.count === 1 ? "" : "s"}.` };
        },
      }),
      import: cliCommand({
        summary:
          "Bring in the comments a PDF exported by Doc Review carries: into that PDF, or with --into into the file they were written on (the .pptx or .docx)",
        positionals: [{ name: "pdf", description: "The PDF with comments (absolute, or relative to the current directory)", required: true }],
        options: {
          into: { type: "string", description: "The file to put the comments on (default: the PDF itself)" },
          json: { type: "boolean", description: "Emit machine-readable JSON" },
        },
        async run(input, ctx) {
          const source = await docAt(input.positionals.pdf, ctx.cwd);
          const target = input.options.into ? await docAt(input.options.into, ctx.cwd) : source;
          const result = await exchange.importInto(source, target).catch((error: unknown) => {
            throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "import_failed" });
          });
          onChanged([source.id, target.id]);
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ file: target.absPath, ...result }) };
          return {
            exitCode: 0,
            stdout:
              `Imported into ${target.absPath}: ${result.added} new comment${result.added === 1 ? "" : "s"}, ${result.updated} with new replies.` +
              (result.added > 0 ? " New ones wait as drafts in Doc Review." : ""),
          };
        },
      }),
      reply: cliCommand({
        summary:
          "Answer a comment without resolving it (a question or why it was not applied); the user can answer back in the comment's thread",
        positionals: [{ name: "id", description: "Comment id", required: true }],
        options: {
          note: {
            type: "string",
            required: true,
            description: `The answer shown to the user (max ${NOTE_MAX} chars)`,
            aliases: ["message"],
            short: "m",
            stdin: true,
          },
          json: { type: "boolean", description: "Emit machine-readable JSON" },
        },
        async run(input) {
          const note = checkNote(input.options.note, true)!;
          const comment = requireComment(input.positionals.id);
          const replied = store.reply(comment.id, note);
          onChanged([comment.doc.id]);
          if (input.options.json) {
            return { exitCode: 0, stdout: JSON.stringify({ replied: replied.id }) };
          }
          return { exitCode: 0, stdout: `Replied on ${replied.id} (#${replied.seq}).` };
        },
      }),
    },
  });
}
