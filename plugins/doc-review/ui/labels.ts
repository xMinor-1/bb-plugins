// Words the panel shares between views: where a comment points, who wrote a
// reply, a comment's status, and the server's errors in the panel's language.
import { defineMessages, getLang, pluralRu, type Lang } from "@/lib/i18n";
import { AUTHOR_WORDS, PLACE_WORDS, type CommentStatus, type DocKind } from "../src/types";

const slideRu = (slide: boolean) => (slide ? "Слайд" : "Страница");

export const placeWords = defineMessages(PLACE_WORDS, {
  wholeDocument: "Весь документ",
  line: (n) => `Строка ${n}`,
  lines: (from, to) => `Строки ${from}–${to}`,
  page: (slide, n) => `${slideRu(slide)} ${n}`,
  pageArea: (slide, n) => `${slideRu(slide)} ${n}, область`,
  pageDrawing: (slide, n) => `${slideRu(slide)} ${n}, рисунок`,
  text: "Текст",
  element: (tag) => `Элемент <${tag}>`,
  drawing: "Рисунок",
});

export const authorWords = defineMessages(AUTHOR_WORDS, {
  agentOf: (name) => `Агент (${name})`,
  agent: "Агент",
  you: "Вы",
  youNotSent: "Вы, не отправлено",
});

export const STATUS_LABELS: Record<Lang, Record<CommentStatus, string>> = {
  en: { draft: "Draft", sent: "Sent", replied: "Answered", resolved: "Done" },
  ru: { draft: "Черновик", sent: "Отправлен", replied: "Есть ответ", resolved: "Готово" },
};

export const countWords = defineMessages(
  {
    comments: (n: number) => `${n} comment${n === 1 ? "" : "s"}`,
    page: (kind: DocKind) => (kind === "presentation" ? "Slide" : "Page"),
    /** The button beside the address bar of bb's browser (ui/web-review.tsx). */
    reviewButton: "Review",
    pin: (n: number) => `Comment ${n}`,
  },
  {
    comments: (n) => `${n} ${pluralRu(n, ["комментарий", "комментария", "комментариев"])}`,
    page: (kind) => (kind === "presentation" ? "Слайд" : "Страница"),
    reviewButton: "Ревью",
    pin: (n) => `Комментарий ${n}`,
  },
);

/**
 * The server's errors in Russian. The server writes them in English for the
 * agents and the CLI too, so the panel translates the ones a person meets;
 * rare internal ones stay as they are.
 */
const SERVER_ERRORS_RU: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^This document is no longer known; reopen the file\.$/, () => "Этот документ больше не известен, откройте файл заново."],
  [/^The file is gone: (.+)$/, (m) => `Файла больше нет: ${m[1]}`],
  [/^No such file: (.+)$/, (m) => `Нет такого файла: ${m[1]}`],
  [/^File not found: (.+)$/, (m) => `Файл не найден: ${m[1]}`],
  [/^Not a web address\.$/, () => "Это не веб-адрес."],
  [/^Doc Review comments on http and https pages\.$/, () => "Doc Review комментирует только страницы http и https."],
  [/^This kind of document has no pages\.$/, () => "У документа такого вида нет страниц."],
  [/^No host is available to browse\.$/, () => "Нет машины, на которой можно посмотреть папки."],
  [/^There are no draft comments to send\.$/, () => "Нет черновиков, которые можно отправить."],
  [
    /^Doc Review opens Markdown, PDF, Word, PowerPoint, Excel, and HTML files\.$/,
    () => "Doc Review открывает файлы Markdown, PDF, Word, PowerPoint, Excel и HTML.",
  ],
  [/^No desktop browser has this tab\.$/, () => "Эта вкладка не открыта ни в одном браузере приложения."],
  [/^Not a Markdown file\.$/, () => "Это не файл Markdown."],
  [/^Not an HTML file\.$/, () => "Это не файл HTML."],
  [/^Not a spreadsheet\.$/, () => "Это не таблица."],
  [/^The file changed; reload it\.$/, () => "Файл изменился, откройте его заново."],
  [/^This workbook has no such sheet\.$/, () => "В книге нет такого листа."],
  [/^This comment was deleted\.$/, () => "Этот комментарий удалён."],
  [/^This comment is not sent yet; edit it instead\.$/, () => "Комментарий ещё не отправлен, просто измените его."],
  [
    /^This file is not in a project, so a new chat cannot be started from here\.$/,
    () => "Файл не в проекте, поэтому новый тред отсюда не начать.",
  ],
  [
    /^The file these comments were written on is not next to this PDF\.$/,
    () => "Файла, к которому писали эти комментарии, нет рядом с этим PDF.",
  ],
  [/^This is not an attached file\.$/, () => "Это не вложенный файл."],
  [/^This chat has no project to keep its attachments\.$/, () => "У этого треда нет проекта, где хранить вложения."],
  [/^This file is too large to review\.$/, () => "Файл слишком большой для ревью."],
  [/^Could not find a free name for the copy\.$/, () => "Не нашлось свободного имени для копии."],
  [/^The path leaves its workspace\.$/, () => "Путь выходит за пределы рабочей папки."],
  [/^This environment has no checkout on disk yet\.$/, () => "У этого окружения ещё нет копии на диске."],
  [/^This project has no checkout on any host\.$/, () => "У этого проекта нет копии ни на одной машине."],
  [/^This workspace file has no environment\.$/, () => "У этого файла рабочей папки нет окружения."],
  [/^This stored file has no thread\.$/, () => "У этого сохранённого файла нет треда."],
  [/^Expected an absolute path\.$/, () => "Нужен абсолютный путь."],
  [
    /^This file is ([\d.]+) MB on another host; files up to ([\d.]+) MB are copied from there\. Download it instead\.$/,
    (m) => `Файл весит ${m[1]} МБ и лежит на другой машине, оттуда копируются файлы до ${m[2]} МБ. Скачайте его.`,
  ],
  [
    /^This file is ([\d.]+) MB; files up to ([\d.]+) MB are converted\. Download it instead\.$/,
    (m) => `Файл весит ${m[1]} МБ, в PDF переводятся файлы до ${m[2]} МБ. Скачайте его.`,
  ],
  [
    /^This spreadsheet is ([\d.]+) MB\. Files in this format are previewed up to ([\d.]+) MB; save it as \.xlsx to view it\.$/,
    (m) => `Таблица весит ${m[1]} МБ, файлы этого формата показываются до ${m[2]} МБ. Сохраните её как .xlsx.`,
  ],
  [
    /^Pages need poppler-utils on the bb server \(pdfinfo, pdftoppm, pdftotext\)\.$/,
    () => "Для страниц нужен poppler-utils на сервере bb (pdfinfo, pdftoppm, pdftotext).",
  ],
  [/^This PDF has no pages\.$/, () => "В этом PDF нет страниц."],
  [
    /^Only PDF, Word, and PowerPoint files are exported with comments\.$/,
    () => "С комментариями выгружаются только файлы PDF, Word и PowerPoint.",
  ],
  [/^This PDF carries no comments from Doc Review\.$/, () => "В этом PDF нет комментариев из Doc Review."],
  [
    /^Comments from a PDF go into a PDF, Word, or PowerPoint file\.$/,
    () => "Комментарии из PDF переносятся только в файл PDF, Word или PowerPoint.",
  ],
  [/^Chrome exited before the picture was taken\.$/, () => "Chrome закрылся раньше, чем снял страницу."],
  [/^Chrome took too long to photograph the page\.$/, () => "Chrome слишком долго снимал страницу."],
];

/** A server error in the current language. */
export function localizeError(message: string): string {
  if (getLang() !== "ru") return message;
  for (const [pattern, ru] of SERVER_ERRORS_RU) {
    const match = pattern.exec(message);
    if (match) return ru(match);
  }
  return message;
}
