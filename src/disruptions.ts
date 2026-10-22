import { primGet } from "./prim.js";
import { cleanText, looksLikeStrike } from "./text.js";
import { fmtDateTime, nowNavitia } from "./time.js";
import type { LineRef } from "./navitia.js";

/** API "Messages Info Trafic – requête globale" (disruptions_bulk). */
interface BulkDisruption {
  id: string;
  applicationPeriods?: { begin: string; end: string }[];
  lastUpdate?: string;
  cause?: string;
  severity?: string;
  tags?: string[];
  title?: string;
  message?: string;
  shortMessage?: string;
}
interface BulkLine {
  id: string;
  name?: string;
  shortName?: string;
  mode?: string;
  impactedObjects?: { type: string; id: string; name?: string; disruptionIds?: string[] }[];
}
interface Bulk {
  disruptions?: BulkDisruption[];
  lines?: BulkLine[];
}

const TTL_MS = Number(process.env.DISRUPTIONS_CACHE_SECONDS ?? 120) * 1000;
let cache: { at: number; data: Bulk } | null = null;
let inflight: Promise<Bulk> | null = null;

/** Un seul appel partagé + cache : l'API a un quota journalier serré. */
async function getBulk(): Promise<Bulk> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!inflight) {
    inflight = primGet<Bulk>("/disruptions_bulk/disruptions/v2")
      .then((data) => {
        cache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** "line:IDFM:C01742" / "line:IDF:C01742" -> "C01742" pour matcher Navitia et l'info trafic. */
const lineKey = (id: string) => id.match(/C\d{5}/)?.[0] ?? id;

const overlaps = (p: { begin: string; end: string }, from: string, to: string) =>
  p.begin <= to && (!p.end || p.end >= from);

export interface TrafficItem {
  title?: string;
  message?: string;
  severity?: string;
  cause?: string;
  likely_strike: boolean;
  active_now: boolean;
  periods: { begin?: string; end?: string }[];
  impacted_stops?: string[];
  last_update?: string;
}

/**
 * Perturbations sur les lignes données, actives sur la fenêtre [from, to]
 * (format Navitia). Par défaut : maintenant -> +24h.
 */
export async function trafficForLines(
  lines: Pick<LineRef, "id" | "code" | "mode">[],
  window?: { from: string; to: string },
) {
  const bulk = await getBulk();
  const from = window?.from ?? nowNavitia();
  const to = window?.to ?? nowNavitia(24 * 60);
  const now = nowNavitia();
  const byId = new Map((bulk.disruptions ?? []).map((d) => [d.id, d]));

  return lines.map((line) => {
    const bulkLine = (bulk.lines ?? []).find((l) => lineKey(l.id) === lineKey(line.id));
    const ids = new Map<string, Set<string>>(); // disruptionId -> arrêts impactés
    for (const obj of bulkLine?.impactedObjects ?? []) {
      for (const dId of obj.disruptionIds ?? []) {
        if (!ids.has(dId)) ids.set(dId, new Set());
        if (obj.type !== "line" && obj.name) ids.get(dId)!.add(obj.name);
      }
    }

    const items: TrafficItem[] = [];
    for (const [dId, stops] of ids) {
      const d = byId.get(dId);
      if (!d) continue;
      const periods = d.applicationPeriods ?? [];
      if (periods.length && !periods.some((p) => overlaps(p, from, to))) continue;
      items.push({
        title: d.title,
        message: cleanText(d.message || d.shortMessage),
        severity: d.severity,
        cause: d.cause,
        likely_strike: looksLikeStrike(d.title, d.message, d.cause, ...(d.tags ?? [])),
        active_now: !periods.length || periods.some((p) => overlaps(p, now, now)),
        periods: periods
          .filter((p) => overlaps(p, from, to))
          .slice(0, 5)
          .map((p) => ({ begin: fmtDateTime(p.begin), end: fmtDateTime(p.end) })),
        impacted_stops: stops.size ? [...stops].slice(0, 15) : undefined,
        last_update: fmtDateTime(d.lastUpdate),
      });
    }

    // Perturbations bloquantes et grèves en premier
    items.sort((a, b) => Number(b.likely_strike) - Number(a.likely_strike) || Number(b.active_now) - Number(a.active_now));

    return { line: line.code, mode: line.mode, line_id: line.id, disruptions: items };
  });
}
