// The dictionary: exact strings by screen group, plus patterns for strings that carry a name or a number.
import type { Dictionary } from "../translate";
import dialogs from "./dialogs.json";
import onboarding from "./onboarding.json";
import settings from "./settings.json";

export const patterns: Dictionary["patterns"] = [
  [/^Update to (\S+)$/, "Обновить до $1"],
  [/^Automatic \((.+)\)$/, "Автоматически ($1)"],
  [/^Default opener for (\.\S+) files$/, "Чем открывать файлы $1"],
  [/^(\.\S+) files$/, "Файлы $1"],
  [/^Everything stays inside (\S+)\.$/, "Всё остаётся внутри $1."],
  [/^Reset to (\/\S*)$/, "Сбросить на $1"],
  [/^Plugin: (\S+)$/, "Плагин: $1"],
  [/^Archive (\d+) threads\?$/, "Перенести треды в архив ($1)?"],
  [/^1 child thread$/, "дочерний тред"],
  [/^(\d+) child threads$/, "дочерние треды ($1)"],
  [/^The skills go in (\S+) and (\S+) on (.+), replacing any copy already there\.$/, "Скиллы лягут в $1 и $2 на машине $3 и заменят прежние копии."],
  [/^Browse to the project folder on (.+), or edit the path directly\.$/, "Выберите папку проекта на машине $1 или впишите путь вручную."],
];

export const dictionary: Dictionary = {
  exact: { ...settings, ...dialogs, ...onboarding },
  patterns,
};
