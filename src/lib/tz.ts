// US formatting in the company's time zone (replaces GR OS's fixed Kigali time).

/** "Nov 24, 2026, 2:05 PM EST" */
export function dateTime(d: Date | null | undefined, tz: string) {
  if (!d) return "";
  return d.toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

/** "11/24/2026" */
export const dateShort = (d: Date, tz: string) => d.toLocaleDateString("en-US", { timeZone: tz, month: "2-digit", day: "2-digit", year: "numeric" });

/** "November 24, 2026" */
export const dateLong = (d: Date, tz: string) => d.toLocaleDateString("en-US", { timeZone: tz, month: "long", day: "numeric", year: "numeric" });

/** "2:05 PM EST" */
export const timeOnly = (d: Date, tz: string) => d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short" });

/** "2026-11-24 19:05 UTC" for certificates, next to local time. */
export const utc = (d: Date | null | undefined) => (d ? `${d.toISOString().slice(0, 16).replace("T", " ")} UTC` : "");

/** Minutes the zone is ahead of UTC at instant d (negative in the US). */
export function offsetMinutes(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - d.getTime()) / 60_000);
}

/** "2026-12-08" -> the instant 11:59 PM that day in the zone (sign-by dates). Null if not a date. */
export function endOfDayIn(ymd: string, tz: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const guess = new Date(`${ymd}T23:59:00Z`);
  if (Number.isNaN(guess.getTime())) return null;
  return new Date(guess.getTime() - offsetMinutes(guess, tz) * 60_000);
}

/** The local calendar date "YYYY-MM-DD" of an instant in the zone. */
export function ymdIn(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Local time with UTC: "Nov 24, 2026, 2:05 PM EST (2026-11-24 19:05 UTC)". */
export const withUtc = (d: Date | null | undefined, tz: string) => (d ? `${dateTime(d, tz)} (${utc(d)})` : "");
