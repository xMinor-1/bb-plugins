// The person's branch choice, changed one change at a time. A change reads the
// choice it builds on inside the queue, so two quick clicks, or a branch and a
// switch at once, never overwrite each other.
import type { BranchChoice } from "./branches.js";

export interface ChoiceStorage {
  read(): Promise<BranchChoice | null>;
  write(choice: BranchChoice): Promise<void>;
}

/** What a change decided: the choice to save (null: save nothing) and its answer. */
export interface ChoiceChange<T> {
  save: BranchChoice | null;
  result: T;
}

export function createChoiceQueue(storage: ChoiceStorage, saved: () => void) {
  let tail: Promise<unknown> = Promise.resolve();
  return function change<T>(apply: (current: BranchChoice | null) => Promise<ChoiceChange<T>> | ChoiceChange<T>): Promise<T> {
    const run = tail.then(async () => {
      const { save, result } = await apply(await storage.read());
      if (save !== null) {
        await storage.write(save);
        saved();
      }
      return result;
    });
    // A failed change answers its caller and does not stop the next one.
    tail = run.catch(() => undefined);
    return run;
  };
}
