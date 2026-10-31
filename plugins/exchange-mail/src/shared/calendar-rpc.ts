// The calendar for other plugins (a personal board, for example, shows today's
// meetings): `bb.sdk.plugins.callRpc({ pluginId: "exchange-mail", method: "calendarEvents", input })`.
// Only plugins listed in the `calendarPlugins` setting get an answer, and they
// get less than the panel: times, subjects and places, no organizer and no
// attendees, and of an event marked private only its time: the subject comes
// as "Private" and the place as null. A plugin on the list takes on the rule the mail tools follow: the
// calendar goes to no model outside the allowed agents.
//
//   input  { start: ISO with a zone, end: ISO with a zone (at most 62 days later), hostId?: string }
//   output { ok: true, events: CalendarEntry[], more: boolean }
//        | { ok: false, reason: "not-allowed" | "no-machine" | "offline" | "not-connected" | "unavailable", message }
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { CalendarEvent } from "../../contract";
import { CALENDAR_TEXT_MAX } from "./limits";

export const calendarEntrySchema = z
  .object({
    id: z.string(),
    /** "Private" for an event marked private. */
    subject: z.string().max(CALENDAR_TEXT_MAX),
    start: z.string(),
    end: z.string(),
    allDay: z.boolean(),
    /** null for an event marked private. */
    location: z.string().max(CALENDAR_TEXT_MAX).nullable(),
    showAs: z.enum(["free", "tentative", "busy", "away", "elsewhere", "unknown"]),
    myResponse: z.enum(["organizer", "accepted", "tentative", "declined", "none", "unknown"]),
    kind: z.enum(["single", "occurrence", "exception"]),
    cancelled: z.boolean(),
    /** Marked private in Outlook: only its time and free/busy come; keep even that out of anything shared. */
    private: z.boolean(),
  })
  .strict();
export type CalendarEntry = z.infer<typeof calendarEntrySchema>;

/** A moment with its zone: without one, the host would read it in its own time zone, which the caller may not know. */
const zoned = z
  .string()
  .min(16)
  .max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i, "an ISO time with a zone, such as 2026-11-02T00:00:00+03:00");

export const calendarFailureSchema = z.enum(["not-allowed", "no-machine", "offline", "not-connected", "unavailable"]);

export const calendarRpcContract = defineRpcContract({
  calendarEvents: {
    experimental_description:
      "The user's Exchange calendar between two moments, recurring meetings expanded: times, subjects, places, free/busy. Only for plugins listed in Exchange Mail's calendarPlugins setting.",
    input: z
      .object({
        start: zoned,
        end: zoned,
        hostId: z.string().min(1).max(200).optional(),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), events: z.array(calendarEntrySchema), more: z.boolean() }).strict(),
      z.object({ ok: z.literal(false), reason: calendarFailureSchema, message: z.string() }).strict(),
    ]),
  },
});

/** Stands for the subject of an event marked private. */
export const PRIVATE_SUBJECT = "Private";

/** What another plugin gets of an event: no organizer, no attendees, and of a private one nothing but its time. */
export function entryOf(event: CalendarEvent): CalendarEntry {
  return {
    id: event.id,
    subject: event.private ? PRIVATE_SUBJECT : event.subject,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    location: event.private ? null : event.location,
    showAs: event.showAs,
    myResponse: event.myResponse,
    kind: event.kind,
    cancelled: event.cancelled,
    private: event.private,
  };
}

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** The calendarPlugins setting: plugin ids separated by spaces, commas or lines. Throws on anything else. */
export function parsePluginList(text: string): string[] {
  const ids = text
    .split(/[\s,;]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  for (const id of ids) if (!PLUGIN_ID.test(id)) throw new Error(`"${id}" is not a plugin id`);
  return [...new Set(ids)];
}
