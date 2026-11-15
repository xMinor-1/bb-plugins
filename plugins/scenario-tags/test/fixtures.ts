export const CATALOG = {
  groups: [
    { id: "contracts", label: "Contracts" },
    { id: "reports", label: "Reports" },
  ],
  scenarios: [
    {
      id: "report-guide",
      label: "Reports",
      group: "reports",
      pinned: true,
      description: "Ask which report answers a question",
      fields: [
        { id: "question", label: "Question", type: "textarea", required: true },
        { id: "period", label: "Period", type: "text", placeholder: "Q3 2026" },
      ],
      prompt: "Read the reports guide first.\nQuestion: {{question}}\nPeriod: {{period}}",
    },
    {
      id: "contract-check",
      label: "Contract check",
      group: "contracts",
      fields: [
        { id: "party", label: "Counterparty", type: "text", required: true },
        { id: "file", label: "Contract", type: "attachment", required: true, answer: "see the attached file" },
        { id: "side", label: "Our side", type: "select", options: ["Buyer", "Seller"] },
      ],
      prompt: "Use the contract-check skill.\nCounterparty: {{party}}\nContract: {{file}}\n{{answers}}",
    },
    { id: "plain", label: "Plain" },
  ],
};
export const CATALOG_JSON = JSON.stringify(CATALOG);
