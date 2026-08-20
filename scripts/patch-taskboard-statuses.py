#!/usr/bin/env python3
"""Три статуса вместо двух в панели Taskboard для GitHub-задач.

Плагин `bb-plugin-taskboard` (чужой, ставится из npm) знает у GitHub-задач только
Open и Closed — канбан из двух колонок. Скрипт правит установленный плагин так,
чтобы колонок стало три: Todo → In Progress → Done. «In Progress» — это открытая
задача, на которой висит любая из меток-стадий: `coding`, `review`, `qa`, `blocked`
или общая `in progress`. Стадия внутри работы меняется меткой, колонка при этом
остаётся одна.

Патч живёт в кэше npm и слетает при обновлении плагина — после
`bb plugin update taskboard` прогнать скрипт заново:

    python3 scripts/patch-taskboard-statuses.py
    bb plugin reload taskboard

Идемпотентен: повторный запуск на уже пропатченной установке ничего не делает.
Флаг `--revert` возвращает файлы из бэкапов `*.tb-orig`.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

CACHE = Path.home() / ".bb/plugins/cache/npm/bb-plugin-taskboard"
MARKER = "hasInProgressLabel"

# ---------------------------------------------------------------- dist/server.js

DIST_REPLACEMENTS: list[tuple[str, str]] = [
    (
        'var okOutputSchema = external_exports.object({ ok: external_exports.literal(true) }).strict();',
        'var okOutputSchema = external_exports.object({ ok: external_exports.literal(true) }).strict();\n'
        'var setLabelsOutputSchema = external_exports.object({\n'
        '  ok: external_exports.literal(true),\n'
        '  labels: external_exports.array(external_exports.string())\n'
        '}).strict();\n'
        'var IN_PROGRESS_LABELS = ["in progress", "coding", "review", "qa", "blocked"];\n'
        'var DEFAULT_STAGE_LABEL = "coding";\n'
        'function hasInProgressLabel(labels) {\n'
        '  return labels.some((label) => IN_PROGRESS_LABELS.includes(label.trim().toLowerCase()));\n'
        '}\n'
        'function stageLabelsFirst(labels) {\n'
        '  const stage = (label) => IN_PROGRESS_LABELS.includes(label.trim().toLowerCase()) ? 0 : 1;\n'
        '  return [...labels].sort((left, right) => stage(left) - stage(right));\n'
        '}',
    ),
    (
        'function toItem(value, comments = []) {\n'
        '  const open = value.state.toLowerCase() === "open";\n'
        '  return {',
        'function toItem(value, comments = []) {\n'
        '  const open = value.state.toLowerCase() === "open";\n'
        '  const inProgress = open && hasInProgressLabel(value.labels);\n'
        '  return {',
    ),
    (
        '    status: value.state,\n'
        '    stateCategory: open ? "todo" : "done",',
        '    status: open ? inProgress ? "In Progress" : "Todo" : "Done",\n'
        '    stateCategory: open ? inProgress ? "in_progress" : "todo" : "done",',
    ),
    (
        '    labels: value.labels,\n'
        '    updatedAt: value.updatedAt,\n'
        '    comments\n'
        '  };\n'
        '}',
        '    labels: stageLabelsFirst(value.labels),\n'
        '    updatedAt: value.updatedAt,\n'
        '    comments\n'
        '  };\n'
        '}',
    ),
    (
        '  async function statusOptions(locator) {\n'
        '    const issue2 = await scopedIssue(locator);\n'
        '    const current = issue2.status.toLowerCase() === "open" ? "open" : "closed";\n'
        '    return [\n'
        '      {\n'
        '        id: "open",\n'
        '        name: "Open",\n'
        '        stateCategory: "todo",\n'
        '        current: current === "open"\n'
        '      },\n'
        '      {\n'
        '        id: "closed",\n'
        '        name: "Closed",\n'
        '        stateCategory: "done",\n'
        '        current: current === "closed"\n'
        '      }\n'
        '    ];\n'
        '  }',
        '  async function statusOptions(locator) {\n'
        '    const detail = await scopedIssue(locator);\n'
        '    return [\n'
        '      {\n'
        '        id: "open",\n'
        '        name: "Todo",\n'
        '        stateCategory: "todo",\n'
        '        current: detail.status === "Todo"\n'
        '      },\n'
        '      {\n'
        '        id: "in-progress",\n'
        '        name: "In Progress",\n'
        '        stateCategory: "in_progress",\n'
        '        current: detail.status === "In Progress"\n'
        '      },\n'
        '      {\n'
        '        id: "closed",\n'
        '        name: "Done",\n'
        '        stateCategory: "done",\n'
        '        current: detail.status === "Done"\n'
        '      }\n'
        '    ];\n'
        '  }',
    ),
    (
        '    async updateStatus(locator, statusId) {\n'
        '      if (!enabled) throw new Error("GitHub is disabled");\n'
        '      const available = await statusOptions(locator);\n'
        '      const target = available.find((option) => option.id === statusId);\n'
        '      if (!target) {\n'
        '        throw new Error("GitHub status is not available for this issue");\n'
        '      }\n'
        '      if (!target.current) {\n'
        '        const { repo, number: number4 } = parseLocator(locator);\n'
        '        await bb.sdk.plugins.callRpc({\n'
        '          pluginId: "github",\n'
        '          method: "setIssueState",\n'
        '          input: { repo, number: number4, state: statusId },\n'
        '          outputSchema: okOutputSchema\n'
        '        });\n'
        '      }\n'
        '      return scopedIssue(locator);\n'
        '    }',
        '    async updateStatus(locator, statusId) {\n'
        '      if (!enabled) throw new Error("GitHub is disabled");\n'
        '      const available = await statusOptions(locator);\n'
        '      const target = available.find((option) => option.id === statusId);\n'
        '      if (!target) {\n'
        '        throw new Error("GitHub status is not available for this issue");\n'
        '      }\n'
        '      if (!target.current) {\n'
        '        const { repo, number: number4 } = parseLocator(locator);\n'
        '        const detail = await scopedIssue(locator);\n'
        '        const wantLabel = statusId === "in-progress";\n'
        '        const hasLabel = hasInProgressLabel(detail.labels);\n'
        '        if (wantLabel !== hasLabel) {\n'
        '          const labels = wantLabel ? [...detail.labels, DEFAULT_STAGE_LABEL] : detail.labels.filter(\n'
        '            (label) => !IN_PROGRESS_LABELS.includes(label.trim().toLowerCase())\n'
        '          );\n'
        '          await bb.sdk.plugins.callRpc({\n'
        '            pluginId: "github",\n'
        '            method: "setLabels",\n'
        '            input: { repo, number: number4, labels },\n'
        '            outputSchema: setLabelsOutputSchema\n'
        '          });\n'
        '        }\n'
        '        const wantState = statusId === "closed" ? "closed" : "open";\n'
        '        const hasState = detail.status === "Done" ? "closed" : "open";\n'
        '        if (wantState !== hasState) {\n'
        '          await bb.sdk.plugins.callRpc({\n'
        '            pluginId: "github",\n'
        '            method: "setIssueState",\n'
        '            input: { repo, number: number4, state: wantState },\n'
        '            outputSchema: okOutputSchema\n'
        '          });\n'
        '        }\n'
        '        await refreshGithubCache(bb);\n'
        '      }\n'
        '      return scopedIssue(locator);\n'
        '    }',
    ),
]

# ---------------------------------------------------------------- sources/github.ts
# Исполняется собранный dist, исходник правим следом, чтобы он не расходился со сборкой.

SOURCE_REPLACEMENTS: list[tuple[str, str]] = [
    (
        'function toItem(\n'
        '  value: z.infer<typeof githubItemSchema>,\n'
        '  comments: ExternalWorkItemDetail[\'comments\'] = []\n'
        '): ExternalWorkItemDetail {\n'
        '  const open = value.state.toLowerCase() === \'open\';\n'
        '  return {',
        'const IN_PROGRESS_LABELS: readonly string[] = [\n'
        '  \'in progress\',\n'
        '  \'coding\',\n'
        '  \'review\',\n'
        '  \'qa\',\n'
        '  \'blocked\'\n'
        '];\n'
        'const DEFAULT_STAGE_LABEL = \'coding\';\n\n'
        'function hasInProgressLabel(labels: readonly string[]): boolean {\n'
        '  return labels.some(label =>\n'
        '    IN_PROGRESS_LABELS.includes(label.trim().toLowerCase())\n'
        '  );\n'
        '}\n\n'
        'function stageLabelsFirst(labels: readonly string[]): string[] {\n'
        '  const stage = (label: string): number =>\n'
        '    IN_PROGRESS_LABELS.includes(label.trim().toLowerCase()) ? 0 : 1;\n'
        '  return [...labels].sort((left, right) => stage(left) - stage(right));\n'
        '}\n\n'
        'function toItem(\n'
        '  value: z.infer<typeof githubItemSchema>,\n'
        '  comments: ExternalWorkItemDetail[\'comments\'] = []\n'
        '): ExternalWorkItemDetail {\n'
        '  const open = value.state.toLowerCase() === \'open\';\n'
        '  const inProgress = open && hasInProgressLabel(value.labels);\n'
        '  return {',
    ),
    (
        '    status: value.state,\n'
        '    stateCategory: open ? \'todo\' : \'done\',',
        '    status: open ? (inProgress ? \'In Progress\' : \'Todo\') : \'Done\',\n'
        '    stateCategory: open ? (inProgress ? \'in_progress\' : \'todo\') : \'done\',',
    ),
    (
        '    labels: value.labels,\n'
        '    updatedAt: value.updatedAt,\n'
        '    comments\n'
        '  };\n'
        '}',
        '    labels: stageLabelsFirst(value.labels),\n'
        '    updatedAt: value.updatedAt,\n'
        '    comments\n'
        '  };\n'
        '}',
    ),
    (
        '    const issue = await scopedIssue(locator);\n'
        '    const current = issue.status.toLowerCase() === \'open\' ? \'open\' : \'closed\';\n'
        '    return [\n'
        '      {\n'
        '        id: \'open\',\n'
        '        name: \'Open\',\n'
        '        stateCategory: \'todo\',\n'
        '        current: current === \'open\'\n'
        '      },\n'
        '      {\n'
        '        id: \'closed\',\n'
        '        name: \'Closed\',\n'
        '        stateCategory: \'done\',\n'
        '        current: current === \'closed\'\n'
        '      }\n'
        '    ];',
        '    const issue = await scopedIssue(locator);\n'
        '    return [\n'
        '      {\n'
        '        id: \'open\',\n'
        '        name: \'Todo\',\n'
        '        stateCategory: \'todo\',\n'
        '        current: issue.status === \'Todo\'\n'
        '      },\n'
        '      {\n'
        '        id: \'in-progress\',\n'
        '        name: \'In Progress\',\n'
        '        stateCategory: \'in_progress\',\n'
        '        current: issue.status === \'In Progress\'\n'
        '      },\n'
        '      {\n'
        '        id: \'closed\',\n'
        '        name: \'Done\',\n'
        '        stateCategory: \'done\',\n'
        '        current: issue.status === \'Done\'\n'
        '      }\n'
        '    ];',
    ),
    (
        '      if (!target.current) {\n'
        '        const { repo, number } = parseLocator(locator);\n'
        '        await bb.sdk.plugins.callRpc({\n'
        '          pluginId: \'github\',\n'
        '          method: \'setIssueState\',\n'
        '          input: { repo, number, state: statusId },\n'
        '          outputSchema: okOutputSchema\n'
        '        });\n'
        '      }',
        '      if (!target.current) {\n'
        '        const { repo, number } = parseLocator(locator);\n'
        '        const detail = await scopedIssue(locator);\n'
        '        const wantLabel = statusId === \'in-progress\';\n'
        '        if (wantLabel !== hasInProgressLabel(detail.labels)) {\n'
        '          const labels = wantLabel\n'
        '            ? [...detail.labels, DEFAULT_STAGE_LABEL]\n'
        '            : detail.labels.filter(\n'
        '                label =>\n'
        '                  !IN_PROGRESS_LABELS.includes(label.trim().toLowerCase())\n'
        '              );\n'
        '          await bb.sdk.plugins.callRpc({\n'
        '            pluginId: \'github\',\n'
        '            method: \'setLabels\',\n'
        '            input: { repo, number, labels },\n'
        '            outputSchema: setLabelsOutputSchema\n'
        '          });\n'
        '        }\n'
        '        const wantState = statusId === \'closed\' ? \'closed\' : \'open\';\n'
        '        const hasState = detail.status === \'Done\' ? \'closed\' : \'open\';\n'
        '        if (wantState !== hasState) {\n'
        '          await bb.sdk.plugins.callRpc({\n'
        '            pluginId: \'github\',\n'
        '            method: \'setIssueState\',\n'
        '            input: { repo, number, state: wantState },\n'
        '            outputSchema: okOutputSchema\n'
        '          });\n'
        '        }\n'
        '        await refreshGithubCache(bb);\n'
        '      }',
    ),
    (
        'const okOutputSchema = z.object({ ok: z.literal(true) }).loose();',
        'const okOutputSchema = z.object({ ok: z.literal(true) }).loose();\n'
        'const setLabelsOutputSchema = z\n'
        '  .object({ ok: z.literal(true), labels: z.array(z.string()) })\n'
        '  .loose();',
    ),
]


# ---------------------------------------------------------------- dist/app.js, dist/app.css
# Панель рисует все метки одинаково серыми. Проставляем каждой метке data-label,
# чтобы в стилях покрасить стадии в их цвета с GitHub.

APP_REPLACEMENTS: list[tuple[str, str]] = [
    (
        '            className: "tb-label-chip min-w-0 truncate rounded-full px-2 py-0.5 text-xs",\n'
        '            title: label,',
        '            className: "tb-label-chip min-w-0 truncate rounded-full px-2 py-0.5 text-xs",\n'
        '            "data-label": label.trim().toLowerCase(),\n'
        '            title: label,',
    ),
    (
        'item.labels.map((label) => /* @__PURE__ */ jsx(Badge, { variant: "secondary", children: label }, label))',
        'item.labels.map((label) => /* @__PURE__ */ jsx(Badge, { variant: "secondary", "data-label": label.trim().toLowerCase(), children: label }, label))',
    ),
]

LABEL_COLORS: list[tuple[str, str]] = [
    ("coding", "#1f6feb"),
    ("review", "#8250df"),
    ("qa", "#bf8700"),
    ("blocked", "#b60205"),
    ("in progress", "#0e8a16"),
    ("now", "#0e8a16"),
    ("next", "#1d76db"),
    ("later", "#6e7781"),
    ("idea", "#d4a72c"),
    ("bug", "#d73a4a"),
]

CSS_MARKER = "/* patch-taskboard-statuses */"


def css_block() -> str:
    rules = [CSS_MARKER]
    for name, color in LABEL_COLORS:
        rules.append(
            f'[data-label="{name}"] {{\n'
            f"  border-color: color-mix(in oklch, {color} 45%, transparent) !important;\n"
            f"  background: color-mix(in oklch, {color} 16%, var(--canvas)) !important;\n"
            f"  color: color-mix(in oklch, {color} 55%, var(--ink)) !important;\n"
            f"}}"
        )
    return "\n" + "\n".join(rules) + "\n"


def installed_plugin_dirs() -> list[Path]:
    if not CACHE.is_dir():
        return []
    dirs = [
        version / "node_modules/bb-plugin-taskboard"
        for version in sorted(CACHE.iterdir())
        if version.is_dir()
    ]
    return [directory for directory in dirs if (directory / "dist/server.js").is_file()]


def apply(
    path: Path,
    replacements: list[tuple[str, str]],
    strict: bool,
    marker: str = MARKER,
) -> bool:
    text = path.read_text(encoding="utf-8")
    if marker in text:
        return False
    updated = text
    for old, new in replacements:
        count = updated.count(old)
        if count != 1:
            if strict:
                sys.exit(
                    f"{path}: ожидался ровно один фрагмент для замены, найдено {count}.\n"
                    f"Плагин изменился — патч нужно переписать под новую версию.\n"
                    f"Фрагмент: {old.splitlines()[0][:80]}…"
                )
            print(f"  пропущен фрагмент ({count} совпадений): {old.splitlines()[0][:60]}…")
            continue
        updated = updated.replace(old, new)
    if updated == text:
        return False
    backup = path.with_suffix(path.suffix + ".tb-orig")
    if not backup.exists():
        shutil.copy2(path, backup)
    path.write_text(updated, encoding="utf-8")
    return True


def append_css(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if CSS_MARKER in text:
        return False
    backup = path.with_suffix(path.suffix + ".tb-orig")
    if not backup.exists():
        shutil.copy2(path, backup)
    path.write_text(text.rstrip("\n") + "\n" + css_block(), encoding="utf-8")
    return True


def revert(directory: Path) -> None:
    for name in ("dist/server.js", "sources/github.ts", "dist/app.js", "dist/app.css"):
        path = directory / name
        backup = path.with_suffix(path.suffix + ".tb-orig")
        if backup.exists():
            shutil.copy2(backup, path)
            print(f"  возвращён {name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revert", action="store_true", help="вернуть файлы из бэкапов")
    args = parser.parse_args()

    directories = installed_plugin_dirs()
    if not directories:
        sys.exit("Плагин bb-plugin-taskboard не найден в кэше npm — нечего патчить.")

    for directory in directories:
        version = directory.parents[1].name
        print(f"taskboard {version}")
        if args.revert:
            revert(directory)
            continue
        changed = apply(directory / "dist/server.js", DIST_REPLACEMENTS, strict=True)
        print("  dist/server.js: " + ("пропатчен" if changed else "уже пропатчен"))
        source = directory / "sources/github.ts"
        if source.is_file():
            changed = apply(source, SOURCE_REPLACEMENTS, strict=False)
            print("  sources/github.ts: " + ("пропатчен" if changed else "уже пропатчен"))
        changed = apply(
            directory / "dist/app.js", APP_REPLACEMENTS, strict=True, marker='"data-label"'
        )
        print("  dist/app.js: " + ("пропатчен" if changed else "уже пропатчен"))
        changed = append_css(directory / "dist/app.css")
        print("  dist/app.css: " + ("пропатчен" if changed else "уже пропатчен"))

    if not args.revert:
        print("\nДальше: bb plugin reload taskboard")


if __name__ == "__main__":
    main()
