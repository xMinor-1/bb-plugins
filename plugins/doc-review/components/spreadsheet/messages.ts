// Texts of the workbook view in both languages.
import { defineMessages, pluralRu } from "@/lib/i18n";

const rowsRu = (n: number) => pluralRu(n, ["строки", "строк", "строк"]);
const colsRu = (n: number) => pluralRu(n, ["столбца", "столбцов", "столбцов"]);

export const sheetMessages = defineMessages(
  {
    rowsAndCols: (shownRows: string, allRows: string, shownCols: string, allCols: string) =>
      `Showing the first ${shownRows} of ${allRows} rows and ${shownCols} of ${allCols} columns.`,
    rows: (shownRows: string, allRows: string) => `Showing the first ${shownRows} of ${allRows} rows.`,
    cols: (shownCols: string, allCols: string) => `Showing the first ${shownCols} of ${allCols} columns.`,
    cellLimit: (limit: string) => `Some cells are not shown: the viewer reads up to ${limit} cells per sheet.`,
    sheet: "sheet",
    chartSheet: (name: string) => `“${name}” is a chart sheet`,
    chartDetail: "Charts are not shown in this viewer. Download the file to see it.",
    cannotShow: (name: string) => `“${name}” can't be shown`,
    cannotShowDetail: "It is a macro or dialog sheet, not a worksheet with cells.",
    couldNotLoad: (name: string) => `Could not load “${name}”`,
    loading: (name: string) => `Loading “${name}”…`,
    empty: "This sheet is empty",
    allHidden: "Every row or column of this sheet is hidden",
    row: "Row",
    sheetRegion: (name: string) => `Sheet ${name}`,
    hiddenCount: (n: number) => `${n} hidden`,
    hiddenSheets: "Hidden sheets",
    open: "Open",
    scrollLeft: "Scroll sheet tabs left",
    scrollRight: "Scroll sheet tabs right",
    sheets: "Sheets",
    hiddenSheet: (name: string) => `${name} (hidden sheet)`,
    loadingShort: "Loading",
    zoomOut: "Zoom out",
    zoomIn: "Zoom in",
    zoomReset: (percent: number) => `Zoom ${percent}%. Reset to 100%`,
    resetTitle: "Reset to 100%",
  },
  {
    // "Первые 1 000 из 5 000 строк": the genitive follows the total.
    rowsAndCols: (shownRows, allRows, shownCols, allCols) =>
      `Показаны первые ${shownRows} из ${allRows} ${rowsRu(count(allRows))} и ${shownCols} из ${allCols} ${colsRu(count(allCols))}.`,
    rows: (shownRows, allRows) => `Показаны первые ${shownRows} из ${allRows} ${rowsRu(count(allRows))}.`,
    cols: (shownCols, allCols) => `Показаны первые ${shownCols} из ${allCols} ${colsRu(count(allCols))}.`,
    cellLimit: (limit) => `Часть ячеек не показана: просмотр читает до ${limit} ячеек на лист.`,
    sheet: "лист",
    chartSheet: (name) => `«${name}» — лист с диаграммой`,
    chartDetail: "Диаграммы здесь не показываются — скачайте файл.",
    cannotShow: (name) => `Лист «${name}» не показать`,
    cannotShowDetail: "Это лист макросов или диалога, а не лист с ячейками.",
    couldNotLoad: (name) => `Не удалось загрузить «${name}»`,
    loading: (name) => `Загружаем «${name}»…`,
    empty: "Лист пустой",
    allHidden: "Все строки или столбцы этого листа скрыты",
    row: "Строка",
    sheetRegion: (name) => `Лист ${name}`,
    hiddenCount: (n) => `скрыто: ${n}`,
    hiddenSheets: "Скрытые листы",
    open: "Открыт",
    scrollLeft: "Прокрутить листы влево",
    scrollRight: "Прокрутить листы вправо",
    sheets: "Листы",
    hiddenSheet: (name) => `${name} (скрытый лист)`,
    loadingShort: "Загружаем",
    zoomOut: "Уменьшить",
    zoomIn: "Увеличить",
    zoomReset: (percent) => `Масштаб ${percent}%. Вернуть 100%`,
    resetTitle: "Вернуть 100%",
  },
);

/** The number in a formatted figure ("5 000" → 5000), for the plural form. */
function count(formatted: string): number {
  return Number(formatted.replace(/\D/g, "")) || 0;
}
