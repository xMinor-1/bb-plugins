// Default texts the tag row puts into the message box. Settings override them
// (a build manifest usually does, in the build's language). No imports: the
// frontend bundle reads these too.

export const SAVE_TOOL = "scenario_save";

export const DEFAULT_BUILDER_PROMPT = [
  "I want to make my own scenario tag for a task I repeat.",
  "Ask me one question at a time:",
  "1. What is the task?",
  "2. Which data, tools, files or skills does it need?",
  "3. What should the form ask me before each run, and which answers are required?",
  "4. What should the result look like?",
  "Then put the scenario together: a short label (up to 30 characters), a one-line description, the form fields and the prompt text, where {{field}} stands for an answer. The prompt must name the tools or skills to use in plain words.",
  `Save it with the ${SAVE_TOOL} tool. I will see a preview and confirm it.`,
].join("\n");

export const DEFAULT_SAVE_CHAT_PROMPT = [
  "Turn this conversation into a scenario tag I can run again.",
  "Keep what I asked for, the data and tools that worked and the shape of the result. Make the parts that change from run to run (a name, a period, a file) into form fields; mark the ones the task cannot do without as required.",
  `Show me the label, the fields and the prompt in a few lines, then save it with the ${SAVE_TOOL} tool. I will see a preview and confirm it.`,
].join("\n");

export const DEFAULT_EDIT_PROMPT = [
  "I want to change my scenario “{{label}}”.",
  `Ask me what to change, then save it with the ${SAVE_TOOL} tool and id "{{id}}". I will see a preview and confirm it.`,
  "The scenario now:",
  "{{scenario}}",
].join("\n");

