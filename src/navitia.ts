import { primGet, PrimError } from "./prim.js";
import { cleanText, normalize } from "./text.js";
import { diffMinutes, fmtDateTime, fmtTime, toNavitiaDatetime } from "./time.js";

const NAV = "/v2/navitia";

/* ------------------------------------------------------------------ */
/* Lieux                                                               */
/* ------------------------------------------------------------------ */

export interface Place {
  id: string;
  name: string;
  type: string;
  coord?: { lon: string; lat: string };
}

export async function searchPlaces(q: string, types?: string[], count = 5): Promise<Place[]> {
  const data = await primGet<{ places?: any[] }>(`${NAV}/places`, { q, count, "type[]": types });
  return (data.places ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    type: p.embedded_type,
    coord: p[p.embedded_type]?.coord,
  }));
}

const ID_PREFIXES = ["stop_area:", "stop_point:", "address:", "admin:", "poi:"];

/** Adresse libre, id Navitia ou coordonnées "lat,lon" -> lieu Navitia. */
export async function resolvePlace(input: string): Promise<Place> {
  const s = input.trim();

  const coords = s.match(/^(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)$/);
  if (coords) {
    let [a, b] = [coords[1], coords[2]];
    // En IDF la latitude (~48-49) est toujours > longitude (~1-3)
    const [lat, lon] = Number(a) > Number(b) ? [a, b] : [b, a];
    return { id: `${lon};${lat}`, name: s, type: "coord", coord: { lon, lat } };
  }
  if (ID_PREFIXES.some((p) => s.startsWith(p))) return { id: s, name: s, type: s.split(":")[0] };

  const places = await searchPlaces(s, undefined, 3);
  if (!places.length) throw new Error(`Lieu introuvable : "${input}"`);
  return places[0];
}

/* ------------------------------------------------------------------ */
/* Lignes                                                              */
/* ------------------------------------------------------------------ */

export interface LineRef {
  id: string;
  code: string;
  name: string;
  mode: string;
  network: string;
}

const MODE_WORDS: Record<string, string[]> = {
  bus: ["bus"],
  noctilien: ["bus", "noctilien"],
  metro: ["metro"],
  m: ["metro"],
  rer: ["rer"],
  transilien: ["transilien", "train"],
  train: ["train", "transilien", "ter"],
  ter: ["ter", "train"],
  tram: ["tram"],
  tramway: ["tram"],
};

function parseLineInput(raw: string): { mode?: string; code: string } {
  const tokens = normalize(raw).replace(/^ligne\s+/, "").split(/\s+/);
  if (tokens.length > 1 && MODE_WORDS[tokens[0]]) return { mode: tokens[0], code: tokens.slice(1).join(" ") };
  return { code: tokens.join(" ") };
}

const lineCache = new Map<string, LineRef[]>();

/**
 * "Bus 277", "Transilien L", "RER A", "Métro 13", "L" ou "line:IDFM:C01742"
 * -> lignes Navitia correspondantes (plusieurs si le code est ambigu).
 */
export async function resolveLine(input: string): Promise<LineRef[]> {
  const raw = input.trim();
  if (raw.startsWith("line:")) return [{ id: raw, code: raw, name: raw, mode: "", network: "" }];

  const cacheKey = normalize(raw);
  const cached = lineCache.get(cacheKey);
  if (cached) return cached;

  const { mode, code } = parseLineInput(raw);
  const queries = [...new Set([raw, code])];
  let result: LineRef[] = [];

  for (const q of queries) {
    const data = await primGet<{ pt_objects?: any[] }>(`${NAV}/pt_objects`, { q, "type[]": ["line"], count: 50 });
    let lines = (data.pt_objects ?? []).filter((o) => o.embedded_type === "line").map((o) => o.line);
    lines = lines.filter((l) => normalize(l.code ?? "") === code);
    if (mode) {
      const words = MODE_WORDS[mode];
      lines = lines.filter((l) => words.some((w) => normalize(l.commercial_mode?.name ?? "").includes(w)));
    }
    if (lines.length) {
      result = lines.map((l) => ({
        id: l.id,
        code: l.code,
        name: l.name,
        mode: l.commercial_mode?.name ?? "",
        network: l.network?.name ?? "",
      }));
      break;
    }
  }

  lineCache.set(cacheKey, result);
  return result;
}

async function resolveLines(inputs: string[] = []) {
  const resolved: LineRef[] = [];
  const unresolved: string[] = [];
  for (const input of inputs) {
    const lines = await resolveLine(input);
    if (lines.length) resolved.push(...lines);
    else unresolved.push(input);
  }
  return { resolved, unresolved };
}

/* ------------------------------------------------------------------ */
/* Itinéraires                                                         */
/* ------------------------------------------------------------------ */

export interface JourneyRequest {
  from: string;
  to: string;
  datetime?: string;
  datetimeRepresents: "departure" | "arrival";
  allowedLines?: string[];
  forbiddenLines?: string[];
  count?: number;
  maxWalkingMinutes?: number;
  maxTransfers?: number;
  wheelchair?: boolean;
}

export interface NavDisruption {
  id: string;
  severity?: string;
  effect?: string;
  status?: string;
  cause?: string;
  message?: string;
  periods?: { begin: string | undefined; end: string | undefined }[];
}

function simplifyNavDisruption(d: any): NavDisruption {
  const msg = (d.messages ?? []).map((m: any) => m.text).sort((a: string, b: string) => b.length - a.length)[0];
  return {
    id: d.id,
    severity: d.severity?.name,
    effect: d.severity?.effect,
    status: d.status,
    cause: d.cause || undefined,
    message: cleanText(msg),
    periods: (d.application_periods ?? []).map((p: any) => ({ begin: fmtDateTime(p.begin), end: fmtDateTime(p.end) })),
  };
}

function sectionDisruptionIds(s: any): string[] {
  const links = [...(s.links ?? []), ...(s.display_informations?.links ?? [])];
  return [...new Set(links.filter((l: any) => l.type === "disruption").map((l: any) => l.id as string))];
}

function simplifySection(s: any, disruptions: Map<string, NavDisruption>) {
  const base = {
    type: s.type as string,
    from: s.from?.name as string | undefined,
    to: s.to?.name as string | undefined,
    departure: fmtTime(s.departure_date_time),
    arrival: fmtTime(s.arrival_date_time),
    duration_min: Math.round((s.duration ?? 0) / 60),
  };

  switch (s.type) {
    case "public_transport": {
      const di = s.display_informations ?? {};
      const delayDep = diffMinutes(s.departure_date_time, s.base_departure_date_time);
      const delayArr = diffMinutes(s.arrival_date_time, s.base_arrival_date_time);
      return {
        ...base,
        mode: di.commercial_mode,
        line: di.code,
        line_id: (s.links ?? []).find((l: any) => l.type === "line")?.id,
        network: di.network,
        direction: di.direction,
        headsign: di.headsign || undefined,
        stops_count: Math.max(0, (s.stop_date_times?.length ?? 1) - 1),
        scheduled_departure: delayDep ? fmtTime(s.base_departure_date_time) : undefined,
        scheduled_arrival: delayArr ? fmtTime(s.base_arrival_date_time) : undefined,
        delay_departure_min: delayDep || undefined,
        delay_arrival_min: delayArr || undefined,
        realtime: s.data_freshness === "realtime",
        disruptions: sectionDisruptionIds(s).map((id) => disruptions.get(id)).filter(Boolean),
      };
    }
    case "street_network":
    case "crow_fly":
      return { ...base, type: "walk", mode: s.mode ?? "walking" };
    case "transfer":
      return { ...base, transfer_type: s.transfer_type };
    case "waiting":
      return { type: "waiting", duration_min: base.duration_min };
    default:
      return base;
  }
}

export async function planJourneys(req: JourneyRequest) {
  const [from, to, allowed, forbidden] = await Promise.all([
    resolvePlace(req.from),
    resolvePlace(req.to),
    resolveLines(req.allowedLines),
    resolveLines(req.forbiddenLines),
  ]);

  const datetime = toNavitiaDatetime(req.datetime);
  const warnings: string[] = [];
  if (allowed.unresolved.length) warnings.push(`Lignes imposées introuvables (ignorées) : ${allowed.unresolved.join(", ")}`);
  if (forbidden.unresolved.length) warnings.push(`Lignes à éviter introuvables (ignorées) : ${forbidden.unresolved.join(", ")}`);
  if (req.allowedLines?.length && !allowed.resolved.length) {
    throw new Error(`Aucune des lignes imposées n'a été trouvée : ${req.allowedLines.join(", ")}. Précise le mode (ex. "Bus 277", "Transilien L").`);
  }

  let data: any;
  try {
    data = await primGet<any>(`${NAV}/journeys`, {
      from: from.id,
      to: to.id,
      datetime,
      datetime_represents: req.datetimeRepresents,
      data_freshness: "realtime",
      count: req.count ?? 3,
      "allowed_id[]": allowed.resolved.length ? allowed.resolved.map((l) => l.id) : undefined,
      "forbidden_uris[]": forbidden.resolved.length ? forbidden.resolved.map((l) => l.id) : undefined,
      max_walking_duration_to_pt: req.maxWalkingMinutes ? req.maxWalkingMinutes * 60 : undefined,
      max_nb_transfers: req.maxTransfers,
      wheelchair: req.wheelchair || undefined,
    });
  } catch (e) {
    if (e instanceof PrimError && /no_solution|no_origin|no_destination|date_out_of_bounds/.test(e.body)) {
      let message = e.body;
      try { message = JSON.parse(e.body)?.error?.message ?? e.body; } catch { /* corps non JSON */ }
      return { from, to, datetime: fmtDateTime(datetime), journeys: [], no_solution: message, warnings };
    }
    throw e;
  }

  const disruptions = new Map<string, NavDisruption>(
    (data.disruptions ?? []).map((d: any) => [d.id, simplifyNavDisruption(d)]),
  );

  const deadline = req.datetimeRepresents === "arrival" ? datetime : undefined;
  const journeys = (data.journeys ?? [])
    .map((j: any) => {
      const sections = (j.sections ?? []).map((s: any) => simplifySection(s, disruptions));
      return {
        leave_at: fmtTime(j.departure_date_time),
        arrive_at: fmtTime(j.arrival_date_time),
        date: fmtDateTime(j.departure_date_time)?.slice(0, 10),
        duration_min: Math.round((j.duration ?? 0) / 60),
        transfers: j.nb_transfers,
        walking_min: Math.round((j.durations?.walking ?? 0) / 60),
        navitia_type: j.type,
        status: j.status || undefined,
        arrives_after_deadline: deadline && j.arrival_date_time > deadline ? true : undefined,
        sections,
        _raw_departure: j.departure_date_time as string,
        _raw_arrival: j.arrival_date_time as string,
      };
    })
    .sort((a: any, b: any) => a._raw_departure.localeCompare(b._raw_departure))
    .map(({ _raw_departure, _raw_arrival, ...rest }: any) => rest);

  return {
    from,
    to,
    datetime: fmtDateTime(datetime),
    datetime_represents: req.datetimeRepresents,
    allowed_lines: allowed.resolved,
    forbidden_lines: forbidden.resolved,
    journeys,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Prochains départs                                                   */
/* ------------------------------------------------------------------ */

export async function nextDepartures(stop: string, line?: string, count = 8, datetime?: string) {
  let stopArea: Place;
  if (stop.startsWith("stop_area:")) stopArea = { id: stop, name: stop, type: "stop_area" };
  else {
    const found = await searchPlaces(stop, ["stop_area"], 3);
    if (!found.length) throw new Error(`Arrêt introuvable : "${stop}"`);
    stopArea = found[0];
  }

  const lines = line ? await resolveLine(line) : [];
  if (line && !lines.length) throw new Error(`Ligne introuvable : "${line}"`);
  const lineIds = new Set(lines.map((l) => l.id));

  const data = await primGet<any>(`${NAV}/stop_areas/${encodeURIComponent(stopArea.id)}/departures`, {
    data_freshness: "realtime",
    count: line ? 60 : count,
    from_datetime: datetime ? toNavitiaDatetime(datetime) : undefined,
  });

  const disruptions = new Map<string, NavDisruption>(
    (data.disruptions ?? []).map((d: any) => [d.id, simplifyNavDisruption(d)]),
  );

  const departures = (data.departures ?? [])
    .filter((d: any) => !line || lineIds.has(d.route?.line?.id))
    .slice(0, count)
    .map((d: any) => {
      const sdt = d.stop_date_time ?? {};
      const delay = diffMinutes(sdt.departure_date_time, sdt.base_departure_date_time);
      const di = d.display_informations ?? {};
      return {
        time: fmtTime(sdt.departure_date_time),
        scheduled: delay ? fmtTime(sdt.base_departure_date_time) : undefined,
        delay_min: delay || undefined,
        realtime: sdt.data_freshness === "realtime",
        mode: di.commercial_mode,
        line: di.code,
        direction: di.direction,
        headsign: di.headsign || undefined,
        disruptions: sectionDisruptionIds(d).map((id) => disruptions.get(id)).filter(Boolean),
      };
    });

  return { stop: stopArea, line_filter: lines, departures };
}
