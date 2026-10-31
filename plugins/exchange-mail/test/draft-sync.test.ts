// A draft card with a confirmation dialog open: what it shows does not change
// under the person, and a new version closes the dialog instead.
import { describe, expect, it } from "vitest";
import type { Draft } from "../contract";
import { arrived } from "../src/app/draft-sync";

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

describe("a version of the draft arriving at the card", () => {
  it("is simply shown while no dialog is open", () => {
    expect(arrived(draft("CK1"), false, draft("CK2", "Version two"))).toEqual({ action: "show", draft: draft("CK2", "Version two") });
    expect(arrived(undefined, false, null)).toEqual({ action: "show", draft: null });
  });

  it("leaves an open dialog alone when the version is the same", () => {
    expect(arrived(draft("CK1"), true, draft("CK1"))).toEqual({ action: "keep" });
  });

  it("closes an open dialog and shows the new version when an agent or Outlook changed it", () => {
    expect(arrived(draft("CK1"), true, draft("CK2", "Version two"))).toEqual({ action: "reopen", draft: draft("CK2", "Version two"), why: "changed" });
  });

  it("closes an open dialog when the draft is gone", () => {
    expect(arrived(draft("CK1"), true, null)).toEqual({ action: "reopen", draft: null, why: "gone" });
  });
});
