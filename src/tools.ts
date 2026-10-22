import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { nextDepartures, planJourneys, resolveLine, searchPlaces } from "./navitia.js";
import { trafficForLines } from "./disruptions.js";
import { nowNavitia } from "./time.js";

const INSTRUCTIONS = `Serveur d'itinéraires en Île-de-France (données IDFM / PRIM, temps réel).
- Toutes les heures sont en heure de Paris. Si l'utilisateur donne seulement une heure, passe "HH:MM" pour aujourd'hui ; pour un autre jour passe "YYYY-MM-DDTHH:MM".
- "Arriver avant 8h50" => datetime="08:50", datetime_represents="arrival". "Partir à 8h" => "departure".
- Lignes : précise toujours le mode ("Bus 277", "Transilien L", "RER A", "Métro 13", "Tram T2").
- "Le 277 ou le 238 puis la L" => allowed_lines=["Bus 277","Bus 238","Transilien L"] (seules ces lignes seront utilisées, la marche reste autorisée).
- Dans ta réponse : heure de départ du domicile, heure de passage du bus, arrivée à la gare, heure du train, arrivée finale, et les perturbations / grèves signalées sur les lignes empruntées.`;

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: `Erreur : ${e instanceof Error ? e.message : String(e)}` }],
});

const toNav = (date?: string, time?: string) =>
  date && time ? `${date.replace(/-/g, "")}T${time.replace(":", "")}00` : undefined;

export function buildServer() {
  const server = new McpServer({ name: "prim-idf", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "plan_journey",
    {
      title: "Calculer un itinéraire",
      description:
        "Calcule un itinéraire en transports en commun en Île-de-France, avec horaires temps réel, retards, " +
        "et les perturbations / grèves signalées sur les lignes utilisées. Permet d'imposer ou d'éviter des lignes " +
        "et de fixer une heure de départ ou d'arrivée maximale.",
      inputSchema: {
        from: z.string().describe('Départ : adresse ("53 boulevard Voltaire, Asnières-sur-Seine"), gare, lieu, "lat,lon" ou id Navitia'),
        to: z.string().describe('Arrivée : même format que from (ex. "Gare Saint-Lazare")'),
        datetime: z.string().optional().describe('"HH:MM" (aujourd\'hui) ou "YYYY-MM-DDTHH:MM", heure de Paris. Vide = maintenant'),
        datetime_represents: z.enum(["departure", "arrival"]).default("departure")
          .describe('"arrival" = arriver au plus tard à datetime ; "departure" = partir à partir de datetime'),
        allowed_lines: z.array(z.string()).optional()
          .describe('Lignes à utiliser exclusivement, avec le mode : ["Bus 277", "Bus 238", "Transilien L"]'),
        forbidden_lines: z.array(z.string()).optional().describe('Lignes à éviter : ["RER A", "Métro 13"]'),
        count: z.number().int().min(1).max(6).default(3).describe("Nombre d'itinéraires souhaités"),
        max_walking_minutes: z.number().int().min(0).max(60).optional().describe("Marche max pour rejoindre le premier arrêt"),
        max_transfers: z.number().int().min(0).max(6).optional(),
        wheelchair: z.boolean().optional().describe("Itinéraire accessible fauteuil"),
      },
    },
    async (args) => {
      try {
        const result = await planJourneys({
          from: args.from,
          to: args.to,
          datetime: args.datetime,
          datetimeRepresents: args.datetime_represents,
          allowedLines: args.allowed_lines,
          forbiddenLines: args.forbidden_lines,
          count: args.count,
          maxWalkingMinutes: args.max_walking_minutes,
          maxTransfers: args.max_transfers,
          wheelchair: args.wheelchair,
        });

        // Info trafic (best effort) sur toutes les lignes empruntées
        const used = new Map<string, { id: string; code: string; mode: string }>();
        for (const j of result.journeys as any[]) {
          for (const s of j.sections) {
            if (s.type === "public_transport" && s.line_id) used.set(s.line_id, { id: s.line_id, code: s.line, mode: s.mode });
          }
        }

        let traffic: unknown = [];
        let traffic_warning: string | undefined;
        if (used.size) {
          const js = result.journeys as any[];
          const windowFrom = toNav(js[0]?.date, js[0]?.leave_at);
          const last = js[js.length - 1];
          const windowTo = toNav(last?.date, last?.arrive_at);
          try {
            const all = await trafficForLines(
              [...used.values()],
              windowFrom && windowTo ? { from: windowFrom, to: windowTo } : undefined,
            );
            traffic = all.filter((l) => l.disruptions.length);
          } catch (e) {
            traffic_warning = `Info trafic indisponible : ${e instanceof Error ? e.message : e}`;
          }
        }

        return json({ ...result, traffic, traffic_warning });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "traffic_info",
    {
      title: "Info trafic / grèves",
      description:
        "Perturbations, travaux et mouvements sociaux en cours ou prévus sur des lignes d'Île-de-France. " +
        "likely_strike=true signale un message qui parle de grève / mouvement social (détection par mots-clés).",
      inputSchema: {
        lines: z.array(z.string()).min(1).describe('Lignes avec le mode : ["Transilien L", "Bus 277", "RER A"]'),
        horizon_hours: z.number().int().min(1).max(168).default(24).describe("Fenêtre à partir de maintenant"),
      },
    },
    async ({ lines, horizon_hours }) => {
      try {
        const refs = [];
        const unresolved: string[] = [];
        for (const l of lines) {
          const found = await resolveLine(l);
          if (found.length) refs.push(...found);
          else unresolved.push(l);
        }
        const result = await trafficForLines(refs, { from: nowNavitia(), to: nowNavitia(horizon_hours * 60) });
        return json({ lines: result, unresolved: unresolved.length ? unresolved : undefined });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "next_departures",
    {
      title: "Prochains départs",
      description: "Prochains passages en temps réel à un arrêt ou une gare, éventuellement filtrés sur une ligne.",
      inputSchema: {
        stop: z.string().describe('Arrêt ou gare : "Asnières-sur-Seine", "Gare Saint-Lazare" ou id stop_area'),
        line: z.string().optional().describe('Filtrer sur une ligne : "Bus 238", "Transilien L"'),
        count: z.number().int().min(1).max(20).default(8),
        datetime: z.string().optional().describe('À partir de "HH:MM" ou "YYYY-MM-DDTHH:MM" (défaut : maintenant)'),
      },
    },
    async ({ stop, line, count, datetime }) => {
      try {
        return json(await nextDepartures(stop, line, count, datetime));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "search_places",
    {
      title: "Rechercher un lieu",
      description: "Recherche d'adresses, gares, arrêts ou lieux pour lever une ambiguïté avant de calculer un itinéraire.",
      inputSchema: {
        query: z.string(),
        type: z.enum(["any", "address", "stop_area", "poi", "administrative_region"]).default("any"),
      },
    },
    async ({ query, type }) => {
      try {
        return json(await searchPlaces(query, type === "any" ? undefined : [type], 8));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
