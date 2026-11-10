// The calendar for a week, Monday to Sunday, in the plugin's time zone (Moscow
// unless the settings name another; src/app/time-zone.tsx):
// every occurrence of a recurring meeting on its own day, moved ones marked,
// cancelled ones struck through. From here the person creates a meeting,
// changes or cancels one they organize and answers invitations: each becomes a
// proposal card above the week, confirmed in a system window like a send.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CalendarEvent } from "../../contract";
import { MeetingCard } from "./MeetingCard";
import { MeetingForm, type FormMode } from "./MeetingForm";
import { meetingTexts } from "./meeting-messages";
import { Button } from "@/components/ui/button";
import { defineMessages, intlLocale, pluralRu, useLang, useMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { fromWallTime, wallTime } from "../shared/zone";
import { addDays, intlZone, startOfDay, useTimeZone, zoneText } from "./time-zone";
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
    events: (n: number) => `${n} ${n === 1 ? "event" : "events"}`,
    zone: (zone: string) => `Times: ${zone}`,
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
    events: (n) => `${n} ${pluralRu(n, ["событие", "события", "событий"])}`,
    zone: (zone) => `Время: ${zone}`,
  },
);

/**
 * Seven columns when the page is wide enough, fewer and wrapping when it is not:
 * the panel's width depends on bb's sidebar, which a media query cannot see.
 * A column is at least 7.5rem; gap-2 makes the six gaps 3rem.
 */
/** Buttons inside a day column, which may be 7.5rem narrow: a long Russian label wraps instead of spilling out. */
const WRAP = "h-auto min-h-8 max-w-full whitespace-normal break-words py-1 text-left text-xs";

const WEEK_COLUMNS = "repeat(auto-fill, minmax(max(7.5rem, calc((100% - 3rem) / 7)), 1fr))";

/** Monday 00:00 of the week holding `date`, in the zone (null: the browser's). */
export function weekStart(date: Date, zone: string | null = null): Date {
  const t = wallTime(date.getTime(), zone);
  return new Date(fromWallTime(t.year, t.month, t.day - ((t.weekday + 6) % 7), 0, 0, zone));
}

/**
 * The midnight nearest to a moment, in the zone. An all-day event runs from
 * midnight to midnight of the mailbox's time zone; shown in a zone a few hours
 * east or west of it, that midnight is the nearest one to the event's start.
 */
function nearestMidnight(ms: number, zone: string | null): Date {
  const before = startOfDay(ms, zone);
  const after = addDays(before, 1, zone);
  return ms - before.getTime() <= after.getTime() - ms ? before : after;
}

/** Whether an event belongs on a day: all-day ones on the dates they were made for, the rest wherever they take time. */
function onDay(event: CalendarEvent, day: Date, zone: string | null): boolean {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  if (!event.allDay) return start < addDays(day, 1, zone).getTime() && end > day.getTime();
  const first = nearestMidnight(start, zone);
  // A day may be 23 or 25 hours long when the clocks change.
  const days = Math.max(1, Math.round((end - start) / (24 * 60 * 60_000)));
  return day.getTime() >= first.getTime() && day.getTime() < addDays(first, days, zone).getTime();
}

/** The events of a day, all-day ones first, then by start. */
export function eventsOfDay(events: readonly CalendarEvent[], day: Date, zone: string | null = null): CalendarEvent[] {
  return events.filter((event) => onDay(event, day, zone)).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
}

export function CalendarWeek({ rpc, hostId, now = () => new Date() }: { rpc: Rpc; hostId: string; now?: () => Date }) {
  const t = useMessages(texts);
  const m = useMessages(meetingTexts);
  const lang = useLang();
  const [form, setForm] = useState<FormMode | null>(null);
  /** Proposals made here, newest first, each with its own card until the page is left. */
  const [pending, setPending] = useState<string[]>([]);
  const explain = useExplain();
  const zone = useTimeZone();
  const [start, setStart] = useState(() => weekStart(now(), zone));
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
    rpc.call("calendar", { hostId, start: start.toISOString(), end: addDays(start, 7, zone).toISOString() }).then(
      (result) => {
        if (request !== latest.current) return;
        setEvents(result.events);
        setMore(result.more);
      },
      (cause) => {
        if (request === latest.current) setError(errorText(cause));
      },
    );
  }, [rpc, hostId, start, zone]);

  useEffect(() => {
    load();
    // Leaving the page drops whatever is still on its way.
    return () => void ++latest.current;
  }, [load]);

  const locale = intlLocale(lang);
  const timeZone = intlZone(zone);
  const range = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone });
  const dayName = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone });
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone });
  const today = weekStart(now(), zone).getTime() === start.getTime() ? startOfDay(now().getTime(), zone).getTime() : null;
  const days = Array.from({ length: 7 }, (_, n) => addDays(start, n, zone));

  const when = (event: CalendarEvent, day: Date) => {
    if (event.allDay) return t.allDay;
    const from = Date.parse(event.start);
    const to = Date.parse(event.end);
    // A meeting that runs over midnight shows where it starts and ends on each day.
    const shownFrom = Math.max(from, day.getTime());
    const midnight = addDays(day, 1, zone).getTime();
    const shownTo = Math.min(to, midnight);
    return `${time.format(shownFrom)}–${shownTo === midnight ? "24:00" : time.format(shownTo)}`;
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
          {range.formatRange(start, addDays(start, 6, zone))}
          {events ? <span className="ml-2 font-normal text-muted-foreground">{t.events(events.length)}</span> : null}
          <span className="ml-2 text-xs font-normal text-muted-foreground">{t.zone(zoneText(zone, start.getTime()))}</span>
        </h2>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" aria-label={t.previous} onClick={() => setStart((week) => addDays(week, -7, zone))}>
            ‹
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setStart(weekStart(now(), zone))}>
            {t.today}
          </Button>
          <Button size="sm" variant="ghost" aria-label={t.next} onClick={() => setStart((week) => addDays(week, 7, zone))}>
            ›
          </Button>
          <Button size="sm" variant="ghost" onClick={() => load()}>
            {t.refresh}
          </Button>
          <Button size="sm" onClick={() => setForm({ action: "create", day: today !== null ? new Date(today) : start })}>
            {m.newMeeting}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{m.hint}</p>

      {pending.length ? (
        <section className="space-y-2" aria-label={m.pending}>
          {pending.map((id) => (
            <MeetingCard key={id} rpc={rpc} target={{ hostId }} id={id} onDone={() => load()} />
          ))}
        </section>
      ) : null}
      {form ? (
        <MeetingForm
          rpc={rpc}
          hostId={hostId}
          mode={form}
          onClose={() => setForm(null)}
          onProposed={(proposal) => {
            setForm(null);
            setPending((list) => [proposal.id, ...list.filter((id) => id !== proposal.id)]);
          }}
        />
      ) : null}

      {error ? <Notice tone="error">{explain(error)}</Notice> : null}
      {events === null && !error ? <Notice tone="info">{t.loading}</Notice> : null}
      {more ? <Notice tone="warn">{t.more}</Notice> : null}

      {events ? (
        <ol className="grid gap-2" style={{ gridTemplateColumns: WEEK_COLUMNS }}>
          {days.map((day) => {
            const list = eventsOfDay(events, day, zone);
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
                            {event.myResponse === "organizer" ? <p className="text-muted-foreground">{m.yourMeeting}</p> : null}
                            {!event.cancelled ? (
                              <div className="flex flex-wrap gap-1 pt-1">
                                {event.myResponse === "organizer" ? (
                                  <>
                                    {event.allDay ? null : (
                                      <Button size="sm" variant="outline" className={WRAP} onClick={() => setForm({ action: "update", event })}>
                                        {m.editMeeting}
                                      </Button>
                                    )}
                                    <Button size="sm" variant="ghost" className={WRAP} onClick={() => setForm({ action: "cancel", event })}>
                                      {m.cancelMeeting}
                                    </Button>
                                  </>
                                ) : event.myResponse !== "unknown" ? (
                                  <Button size="sm" variant="outline" className={WRAP} onClick={() => setForm({ action: "respond", event })}>
                                    {m.respond}
                                  </Button>
                                ) : null}
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
