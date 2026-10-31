// The address book without Exchange: the ResolveNames answers it reads, the
// recipients typed in a field, and the agent tool that leaves the choice
// among people with similar names to the person.
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { Person } from "../contract";
import { parseResolveNames } from "../src/host/ews/parse";
import { resolveNames } from "../src/host/ews/soap";
import { lastRecipient, recipientText, splitRecipients } from "../src/shared/recipients";
import plugin, { PERSON_CHOICE } from "../server";

const wrap = (inner: string, status = "Success", code = "NoError") =>
  `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">` +
  `<m:ResolveNamesResponse><m:ResponseMessages><m:ResolveNamesResponseMessage ResponseClass="${status}"><m:MessageText>x</m:MessageText><m:ResponseCode>${code}</m:ResponseCode>${inner}` +
  `</m:ResolveNamesResponseMessage></m:ResponseMessages></m:ResolveNamesResponse></s:Body></s:Envelope>`;

describe("ResolveNames", () => {
  it("asks for full contact data, the address book first, the query as plain ASCII", () => {
    const request = resolveNames('Денис <"&>');
    expect(request).toContain('<m:ResolveNames ReturnFullContactData="true" SearchScope="ActiveDirectoryContacts" ContactDataShape="AllProperties">');
    expect(request).toContain("<m:UnresolvedEntry>&#x414;&#x435;&#x43d;&#x438;&#x441; &lt;&quot;&amp;&gt;</m:UnresolvedEntry>");
  });

  it("reads several matches from a Warning, with job title, department, groups and contacts", () => {
    const found = parseResolveNames(
      wrap(
        `<m:ResolutionSet TotalItemsInView="3" IncludesLastItemInRange="true">` +
          `<t:Resolution><t:Mailbox><t:Name>Denis O</t:Name><t:EmailAddress>denis.o@example.test</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType><t:MailboxType>Mailbox</t:MailboxType></t:Mailbox>` +
          `<t:Contact><t:DisplayName>Denis Orlov</t:DisplayName><t:JobTitle>Engineer</t:JobTitle><t:Department>Platform</t:Department><t:CompanyName>Example</t:CompanyName><t:OfficeLocation>301</t:OfficeLocation></t:Contact></t:Resolution>` +
          `<t:Resolution><t:Mailbox><t:Name>Design</t:Name><t:EmailAddress>design@example.test</t:EmailAddress><t:MailboxType>PublicDL</t:MailboxType></t:Mailbox></t:Resolution>` +
          `<t:Resolution><t:Mailbox><t:Name>Dave</t:Name><t:EmailAddress>dave@example.test</t:EmailAddress><t:MailboxType>Contact</t:MailboxType></t:Mailbox><t:Contact><t:DisplayName>Dave</t:DisplayName></t:Contact></t:Resolution>` +
          `</m:ResolutionSet>`,
        "Warning",
        "ErrorNameResolutionMultipleResults",
      ),
    );
    expect(found).toEqual({
      total: 3,
      people: [
        { name: "Denis Orlov", email: "denis.o@example.test", title: "Engineer", department: "Platform", company: "Example", office: "301", kind: "person" },
        { name: "Design", email: "design@example.test", title: null, department: null, company: null, office: null, kind: "group" },
        { name: "Dave", email: "dave@example.test", title: null, department: null, company: null, office: null, kind: "contact" },
      ],
    });
  });

  it("takes the SMTP address when the mailbox has only an X.500 one, and skips entries without any", () => {
    const found = parseResolveNames(
      wrap(
        `<m:ResolutionSet TotalItemsInView="2">` +
          `<t:Resolution><t:Mailbox><t:Name>Eve</t:Name><t:EmailAddress>/o=Example/ou=Admin/cn=Recipients/cn=eve</t:EmailAddress><t:RoutingType>EX</t:RoutingType></t:Mailbox>` +
          `<t:Contact><t:DisplayName>Eve Example</t:DisplayName><t:EmailAddresses><t:Entry Key="EmailAddress1">X500:/o=Example/cn=eve</t:Entry><t:Entry Key="EmailAddress2">SMTP:eve@example.test</t:Entry></t:EmailAddresses></t:Contact></t:Resolution>` +
          `<t:Resolution><t:Mailbox><t:Name>Nobody</t:Name><t:EmailAddress>/o=Example/cn=nobody</t:EmailAddress></t:Mailbox></t:Resolution>` +
          `</m:ResolutionSet>`,
      ),
    );
    expect(found.people).toMatchObject([{ name: "Eve Example", email: "eve@example.test" }]);
  });

  it("answers no match with an empty list and keeps other errors", () => {
    expect(parseResolveNames(wrap("", "Error", "ErrorNameResolutionNoResults"))).toEqual({ people: [], total: 0 });
    expect(() => parseResolveNames(wrap("", "Error", "ErrorAccessDenied"))).toThrow();
  });
});

describe("recipients in a field", () => {
  it("splits at commas, semicolons and line breaks, but not inside quotes or <…>", () => {
    expect(splitRecipients('"Ivanov, Ivan" <ivan@example.test>; bob@example.test,\n Carol <carol@example.test>,')).toEqual([
      '"Ivanov, Ivan" <ivan@example.test>',
      "bob@example.test",
      "Carol <carol@example.test>",
    ]);
  });

  it("knows the recipient being typed at the end", () => {
    expect(lastRecipient("Bob <bob@example.test>, Den")).toEqual({ head: "Bob <bob@example.test>,", typing: " Den" });
    expect(lastRecipient('"Ivanov, Iv')).toEqual({ head: "", typing: '"Ivanov, Iv' });
  });

  it("writes a person as a recipient, quoting a name with a separator", () => {
    expect(recipientText({ name: "Ivanov, Ivan", email: "ivan@example.test" })).toBe('"Ivanov, Ivan" <ivan@example.test>');
    expect(recipientText({ name: "Denis Orlov", email: "d@example.test" })).toBe("Denis Orlov <d@example.test>");
    expect(recipientText({ name: "d@example.test", email: "d@example.test" })).toBe("d@example.test");
  });
});

const ALLOWED = { providerId: "acp-opencode", model: "corp/large" };
const person = (name: string, email: string, title: string | null = null): Person => ({ name, email, title, department: "Platform", company: null, office: null, kind: "person" });
const DENISES = [person("Denis Orlov", "denis.orlov@example.test", "Engineer"), person("Denis Petrov", "denis.petrov@example.test", "Accountant")];

async function setup(people: Person[]) {
  const hostCalls: { method: string; input: unknown }[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "exchange-mail",
    settings: { allowedModels: "acp-opencode corp/*", ewsUrl: "" },
    agentSkillIds: ["exchange-mail"],
    experimental_hostEntry: true,
    sdk: {
      threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, environmentId: "env_mac", providerId: "acp-opencode", sourceThreadId: null }) },
      environments: { get: async () => ({ id: "env_mac", hostId: "host_mac" }) },
    } as never,
    experimental_callHostRpc: async ({ method, input }) => {
      hostCalls.push({ method, input });
      if (method === "tool") return { text: people.length === 1 ? `One match: ${people[0]!.name}` : `${people.length} matches`, isError: false, draftId: null, people };
      return {};
    },
  });
  await plugin(bb);
  await harness.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread: { id: "th_1", sourceThreadId: null }, requestedExecution: ALLOWED }));
  const find = (query: string) => harness.behavior.callAgentTool("mail_find_person", { query }, { threadId: "th_1" }) as Promise<{ content: { text: string }[]; isError?: boolean }>;
  /** The card bb would show, once the tool has asked for it. */
  const card = async () => {
    for (let n = 0; n < 50 && harness.pendingInteractions.length === 0; n++) await new Promise((resolve) => setTimeout(resolve, 5));
    return harness.pendingInteractions.at(-1)!;
  };
  return { harness, hostCalls, find, card };
}

describe("mail_find_person", () => {
  it("answers one match at once, without asking the person", async () => {
    const s = await setup([DENISES[0]!]);
    const result = await s.find("Orlov");
    expect(result.content[0]!.text).toBe("One match: Denis Orlov");
    expect(s.harness.pendingInteractions).toHaveLength(0);
    expect(s.hostCalls).toEqual([{ method: "tool", input: { tool: "people", query: "Orlov" } }]);
  });

  it("lets the person choose among several, and gives the agent only the one chosen", async () => {
    const s = await setup(DENISES);
    const running = s.find("Denis");
    const card = await s.card();
    expect(card).toMatchObject({ threadId: "th_1", rendererId: PERSON_CHOICE, payload: { query: "Denis", people: DENISES } });
    s.harness.submitInteraction(card.id, { email: "DENIS.PETROV@example.test", lang: "ru" });
    const result = await running;
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe("The user chose: Denis Petrov <denis.petrov@example.test> — Accountant, Platform");
    expect(result.content[0]!.text).not.toContain("Orlov");
  });

  it("accepts only a person it offered: anything else counts as none of them", async () => {
    const s = await setup(DENISES);
    const running = s.find("Denis");
    s.harness.submitInteraction((await s.card()).id, { email: "mallory@example.test" });
    expect((await running).content[0]!.text).toMatch(/^The user said none of the 2 people matching "Denis" is the one/);
  });

  it("tells the agent to ask when the person closes the card, without an error that an idle agent would miss", async () => {
    const s = await setup(DENISES);
    const running = s.find("Denis");
    s.harness.cancelInteraction((await s.card()).id);
    const result = await running;
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toMatch(/did not choose anyone .*Ask them in the chat who they mean; do not pick someone yourself\./);
  });

  it("gives nothing once the agents allowed have changed while the person chose", async () => {
    const s = await setup(DENISES);
    const running = s.find("Denis");
    const card = await s.card();
    await s.harness.behavior.setSettings({ allowedModels: "" });
    s.harness.submitInteraction(card.id, { email: "denis.orlov@example.test" });
    const result = await running;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain("denis");
  });
});
