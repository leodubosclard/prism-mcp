const BASE_URL = (process.env.PRIM_BASE_URL ?? "https://prim.iledefrance-mobilites.fr/marketplace").replace(/\/$/, "");

export class PrimError extends Error {
  constructor(message: string, public status: number, public body: string) {
    super(message);
  }
}

type ParamValue = string | number | boolean | string[] | undefined;

/** GET sur l'API PRIM, clé passée dans le header `apikey`. */
export async function primGet<T>(path: string, params: Record<string, ParamValue> = {}): Promise<T> {
  const apiKey = process.env.PRIM_API_KEY;
  if (!apiKey) throw new Error("PRIM_API_KEY manquante dans le .env");

  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v));
    else url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    headers: { apikey: apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PrimError(`PRIM ${res.status} sur ${path}: ${body.slice(0, 300)}`, res.status, body);
  }
  return (await res.json()) as T;
}
