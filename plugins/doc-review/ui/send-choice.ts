export type SendChoice = "queue" | "immediate" | "new";

const KEY = "doc-review:send-choice";

export function readSendChoice(storage: Pick<Storage, "getItem">): SendChoice {
  const value = storage.getItem(KEY);
  return value === "immediate" || value === "new" ? value : "queue";
}

export function writeSendChoice(storage: Pick<Storage, "setItem">, choice: SendChoice): void {
  storage.setItem(KEY, choice);
}
