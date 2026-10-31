// The calendar for a week, Monday to Sunday, in the browser's time zone:
// every occurrence of a recurring meeting on its own day, moved ones marked,
// cancelled ones struck through. Read only — meetings are made in Outlook.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CalendarEvent } from "../../contract";
import { Button } from "@/components/ui/button";
import { defineMessages, intlLocale, pluralRu, useLang, useMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Notice, errorText } from "./ui";
import { useExplain } from "./errors";
import type { Rpc } from "./rpc";

const texts = defineMessages(
  {
    previous: "Previous week",
    next: "Next week",
    today: "Today",
    refresh: "Refresh",
    loading: "Loading the calendar…",
    nothing: "Nothing planned",
    allDay: "all day",
    recurring: "recurring",
    moved: "recurring, moved",
    cancelled: "cancelled",
    tentative: "tentative",
    free: "free",
    away: "away",
    elsewhere: "elsewhere",
    declined: "you declined",
    notAnswered: "not answered",
    private: "private",
    organizer: "Organizer",
    invited: "Invited",
    more: "This week has more events than shown here. Outlook shows them all.",
    readOnly: "Read only: meetings are created and changed in Outlook.",
    events: (n: number) => `${n} ${n === 1 ? "event" : "events"}`,
  },
  {
    previous: "Предыдущая неделя",
    next: "Следующая неделя",
    today: "Сегодня",
    refresh: "Обновить",
    loading: "Загружаю календарь…",
    nothing: "Ничего не запланировано",
    allDay: "весь день",
    recurring: "повторяется",
    moved: "повторяется, перенесена",
    cancelled: "отменена",
    tentative: "под вопросом",
    free: "свободно",
    away: "нет на месте",
    elsewhere: "работает в другом месте",
    declined: "вы отказались",
    notAnswered: "без ответа",
    private: "личное",
    organizer: "Организатор",
    invited: "Приглашены",
    more: "На этой неделе событий больше, чем показано. Все они есть в Outlook.",
    readOnly: "Только просмотр: встречи создаются и меняются в Outlook.",
    events: (n) => `${n} ${pluralRu(n, ["событие", "события", "событий"])}`,
  },
);

/**
 * Seven columns when the page is wide enough, fewer and wrapping when it is not:
 * the panel's width depends on bb's sidebar, which a media query cannot see.
 * A column is at least 7.5rem; gap-2 makes the six gaps 3rem.
 */
const WEEK_COLUMNS = "repeat(auto-fill, minmax(max(7.5rem, calc((100% - 3rem) / 7)), 1fr))";

/** Monday 00:00 of the week holding `date`, in the browser's time zone. */
export function weekStart(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const fromMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - fromMonday);
  return start;
}

const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/** The events that touch a day, all-day ones first, then by start. */
export function eventsOfDay(events: readonly CalendarEvent[], day: Date): CalendarEvent[] {
  const from = day.getTime();
  const to = addDays(day, 1).getTime();
  return events
    .filter((event) => Date.parse(event.start) < to && Date.parse(event.end) > from)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
}

export function CalendarWeek({ rpc, hostId, now = () => new Date() }: { rpc: Rpc; hostId: string; now?: () => Date }) {
  const t = useMessages(texts);
  const lang = useLang();
  const explain = useExplain();
  const [start, setStart] = useState(() => weekStart(now()));
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  /** Only the latest request may fill the page: a slow answer for another week or an earlier Refresh is dropped. */
  const latest = useRef(0);

  const load = useCallback(() => {
    const request = ++latest.current;
    setEvents(null);
    setMore(false);
    setError(null);
    rpc.call("calendar", { hostId, start: start.toISOString(), end: addDays(start, 7).toISOString() }).then(
      (result) => {
        if (request !== latest.current) return;
        setEvents(result.events);
        setMore(result.more);
      },
      (cause) => {
        if (request === latest.current) setError(errorText(cause));
      },
    );
  }, [rpc, hostId, start]);

  useEffect(() => {
    load();
    // Leaving the page drops whatever is still on its way.
    return () => void ++latest.current;
  }, [load]);

  const locale = intlLocale(lang);
  const range = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" });
  const dayName = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" });
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const today = weekStart(now()).getTime() === start.getTime() ? new Date(now().getFullYear(), now().getMonth(), now().getDate()).getTime() : null;
  const days = Array.from({ length: 7 }, (_, n) => addDays(start, n));

  const when = (event: CalendarEvent, day: Date) => {
    if (event.allDay) return t.allDay;
    const from = Date.parse(event.start);
    const to = Date.parse(event.end);
    // A meeting that runs over midnight shows where it starts and ends on each day.
    const shownFrom = Math.max(from, day.getTime());
    const shownTo = Math.min(to, addDays(day, 1).getTime());
    return `${time.format(shownFrom)}–${shownTo === addDays(day, 1).getTime() ? "24:00" : time.format(shownTo)}`;
  };

  const badges = (event: CalendarEvent) =>
    [
      event.cancelled ? t.cancelled : null,
      event.kind === "exception" ? t.moved : event.kind === "occurrence" ? t.recurring : null,
      event.showAs === "tentative" ? t.tentative : event.showAs === "free" ? t.free : event.showAs === "away" ? t.away : event.showAs === "elsewhere" ? t.elsewhere : null,
      event.myResponse === "declined" ? t.declined : event.myResponse === "none" ? t.notAnswered : null,
      event.private ? t.private : null,
    ].filter((badge): badge is string => badge !== null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {range.formatRange(start, addDays(start, 6))}
          {events ? <span className="ml-2 font-normal text-muted-foreground">{t.events(events.length)}</span> : null}
        </h2>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" aria-label={t.previous} onClick={() => setStart((week) => addDays(week, -7))}>
            ‹
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setStart(weekStart(now()))}>
            {t.today}
          </Button>
          <Button size="sm" variant="ghost" aria-label={t.next} onClick={() => setStart((week) => addDays(week, 7))}>
            ›
          </Button>
          <Button size="sm" variant="ghost" onClick={() => load()}>
            {t.refresh}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t.readOnly}</p>

      {error ? <Notice tone="error">{explain(error)}</Notice> : null}
      {events === null && !error ? <Notice tone="info">{t.loading}</Notice> : null}
      {more ? <Notice tone="warn">{t.more}</Notice> : null}

      {events ? (
        <ol className="grid gap-2" style={{ gridTemplateColumns: WEEK_COLUMNS }}>
          {days.map((day) => {
            const list = eventsOfDay(events, day);
            const isToday = today === day.getTime();
            return (
              <li key={day.getTime()} className={cn("min-w-0 rounded-lg border border-border p-2", isToday && "border-foreground/40 bg-muted/30")} aria-current={isToday ? "date" : undefined}>
                <h3 className={cn("mb-2 text-xs font-medium text-muted-foreground", isToday && "text-foreground")}>{dayName.format(day)}</h3>
                {list.length === 0 ? <p className="text-xs text-muted-foreground">{t.nothing}</p> : null}
                <ul className="space-y-1.5">
                  {list.map((event) => {
                    const key = `${event.id}:${day.getTime()}`;
                    const marks = badges(event);
                    const expanded = open === key;
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => setOpen(expanded ? null : key)}
                          className={cn(
                            "w-full rounded-md border border-border px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                            (event.cancelled || event.myResponse === "declined") && "opacity-60",
                            event.showAs === "free" && "border-dashed",
                          )}
                        >
                          <span className="block text-muted-foreground">{when(event, day)}</span>
                          <span className={cn("block break-words font-medium", event.cancelled && "line-through")}>{event.subject || "—"}</span>
                          {event.location ? <span className="block break-words text-muted-foreground">{event.location}</span> : null}
                          {marks.length ? <span className="mt-0.5 block text-muted-foreground">{marks.join(", ")}</span> : null}
                        </button>
                        {expanded ? (
                          <dl className="mt-1 space-y-1 rounded-md bg-muted/40 px-2 py-1.5 text-xs">
                            {event.organizer ? (
                              <div>
                                <dt className="text-muted-foreground">{t.organizer}</dt>
                                <dd className="break-words">{event.organizer.name ?? event.organizer.email}</dd>
                              </div>
                            ) : null}
                            {event.attendees ? (
                              <div>
                                <dt className="text-muted-foreground">{t.invited}</dt>
                                <dd className="break-words">{event.attendees}</dd>
                              </div>
                            ) : null}
                          </dl>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
