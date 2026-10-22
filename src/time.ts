const TZ = "Europe/Paris";

const pad = (n: string | number) => String(n).padStart(2, "0");

function parisParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return p as Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>;
}

/** Maintenant, heure de Paris, au format Navitia (YYYYMMDDTHHMMSS). */
export function nowNavitia(offsetMinutes = 0): string {
  const p = parisParts(new Date(Date.now() + offsetMinutes * 60_000));
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}

/**
 * Accepte "8h50", "08:50", "2026-10-19T08:50", "2026-10-19 08:50" ou rien (= maintenant).
 * Toujours interprété en heure de Paris.
 */
export function toNavitiaDatetime(input?: string): string {
  if (!input?.trim()) return nowNavitia();
  const s = input.trim();

  let m = s.match(/^(\d{1,2})\s*[:hH]\s*(\d{2})?$/);
  if (m) {
    const p = parisParts();
    return `${p.year}${p.month}${p.day}T${pad(m[1])}${m[2] ?? "00"}00`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2})[:hH](\d{2})(?::(\d{2}))?/);
  if (m) return `${m[1]}${m[2]}${m[3]}T${pad(m[4])}${m[5]}${m[6] ?? "00"}`;
  if (/^\d{8}T\d{6}$/.test(s)) return s;

  throw new Error(`Date/heure non reconnue : "${input}". Formats acceptés : "HH:MM" ou "YYYY-MM-DDTHH:MM".`);
}

/** "20261019T084500" -> "08:45" */
export const fmtTime = (nav?: string) => (nav ? `${nav.slice(9, 11)}:${nav.slice(11, 13)}` : undefined);

/** "20261019T084500" -> "2026-10-19 08:45" */
export const fmtDateTime = (nav?: string) =>
  nav ? `${nav.slice(0, 4)}-${nav.slice(4, 6)}-${nav.slice(6, 8)} ${fmtTime(nav)}` : undefined;

function navToMs(nav: string): number {
  return Date.UTC(+nav.slice(0, 4), +nav.slice(4, 6) - 1, +nav.slice(6, 8), +nav.slice(9, 11), +nav.slice(11, 13), +nav.slice(13, 15));
}

/** Écart en minutes (a - b), undefined si une des deux valeurs manque. */
export function diffMinutes(a?: string, b?: string): number | undefined {
  if (!a || !b) return undefined;
  return Math.round((navToMs(a) - navToMs(b)) / 60_000);
}
