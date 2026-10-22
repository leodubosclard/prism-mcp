/** Retire le HTML des messages d'info trafic et tronque. */
export function cleanText(html?: string, max = 700): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? text.slice(0, max) + "…" : text;
}

const SOCIAL = /gr[eè]ve|mouvement social|mouvements sociaux|pr[ée]avis|conflit social|appel national|interprofessionnel/i;

/** Heuristique "best effort" : le message parle-t-il d'une grève / d'un mouvement social ? */
export const looksLikeStrike = (...texts: (string | undefined)[]) => texts.some((t) => !!t && SOCIAL.test(t));

export const normalize = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
