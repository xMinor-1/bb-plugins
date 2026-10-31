// One line about a person from the address book, for agents. Shared by the
// host (search results) and the server (the person the user chose).
import type { Person } from "../../contract";

/** "Name <email> — Title, Department, Company (group)". The office is for the person's eyes only: the panel shows it, agents do not get it. */
export function formatPerson(person: Person): string {
  const address = person.name && person.name !== person.email ? `${person.name} <${person.email}>` : person.email;
  const details = [person.title, person.department, person.company].filter((part): part is string => Boolean(part));
  const kind = person.kind === "group" ? " (group)" : person.kind === "contact" ? " (personal contact)" : "";
  return `${address}${details.length ? ` — ${details.join(", ")}` : ""}${kind}`;
}
