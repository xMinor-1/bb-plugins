// A draft card with a confirmation dialog open: what it shows does not change
// under the person, and a new version closes the dialog instead.
import { describe, expect, it } from "vitest";
import type { Draft } from "../contract";
import { whileConfirming } from "../src/app/draft-sync";

const draft = (revision: string, text = "Version one"): Draft => ({
  id: "d_000000000001",
  kind: "reply",
  source: "agent",
  threadId: "thr_1",
  createdAt: 1,
  subject: "RE: Plan",
  to: [{ name: null, email: "bob@example.test" }],
  cc: [],
  bcc: [],
  attachments: [],
  bodyFormat: "text",
  body: text,
  text,
  replyTo: null,
  revision,
});

describe("a draft changing while the dialog is open", () => {
  it("keeps the dialog when the version is the same", () => {
    expect(whileConfirming(draft("CK1"), draft("CK1"))).toEqual({ action: "keep" });
  });

  it("closes the dialog and shows the new version when an agent or Outlook changed it", () => {
    expect(whileConfirming(draft("CK1"), draft("CK2", "Version two"))).toEqual({ action: "reopen", why: "changed" });
  });

  it("closes the dialog when the draft is gone", () => {
    expect(whileConfirming(draft("CK1"), null)).toEqual({ action: "reopen", why: "gone" });
  });
});
