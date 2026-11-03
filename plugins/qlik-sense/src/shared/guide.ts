// A company's notes on its Qlik reports, kept in one plugin setting and read by
// allowed agents through the qlik_guide tool. Settings hold only strings, so a
// `# Title` line starts a section: the first section is what an agent reads
// first, the others are read one at a time when the question needs them.

export const MAX_GUIDE_CHARS = 100_000;

export interface GuideSection {
  title: string;
  body: string;
}

export interface GuideAnswer {
  text: string;
  isError: boolean;
}

const HEADING = /^# +(\S.*?)\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function parseGuide(text: string): GuideSection[] {
  const sections: { title: string; lines: string[] }[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : HEADING.exec(line);
    if (heading) {
      sections.push({ title: heading[1]!, lines: [line] });
    } else if (sections.length) {
      sections[sections.length - 1]!.lines.push(line);
    } else if (line.trim()) {
      sections.push({ title: "", lines: [line] });
    }
  }
  return sections.map(({ title, lines }) => ({ title, body: lines.join("\n").trim() }));
}

const norm = (value: string) => value.trim().toLocaleLowerCase();

const sectionList = (sections: GuideSection[]) => sections.map((section) => `- ${section.title}`).join("\n");

export function guideAnswer(text: string, section: string | undefined): GuideAnswer {
  const sections = parseGuide(text);
  const first = sections[0];
  if (!first) return { text: "No Qlik guide is configured here.", isError: false };
  const others = sections.slice(1);

  if (!section?.trim()) {
    const list = others.length ? `\n\n## More sections of this guide\n\nRead one with the \`section\` parameter:\n${sectionList(others)}` : "";
    return { text: `${first.body}${list}`, isError: false };
  }

  const wanted = norm(section);
  const titled = sections.filter((candidate) => candidate.title);
  const found = titled.find((candidate) => norm(candidate.title) === wanted) ?? titled.find((candidate) => norm(candidate.title).includes(wanted));
  if (!found) return { text: `Error: this guide has no section "${section.trim()}". Sections:\n${sectionList(titled)}`, isError: true };
  return { text: found.body, isError: false };
}
