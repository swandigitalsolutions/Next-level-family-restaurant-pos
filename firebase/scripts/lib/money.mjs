// Money + local-time helpers for the ETL — mirrors
// firebase/functions/src/lib/money.ts (round2) and normalize.ts (searchTokens).

export const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

/**
 * SQLite stores timestamps as naive Asia/Kolkata local strings
 * ("YYYY-MM-DD HH:MM:SS"). dateKey/hour come straight from the string; the
 * Firestore Timestamp is built as that wall-clock time at +05:30.
 */
export function parseLocalTs(s) {
  const str = String(s || "").trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) {
    const d = new Date();
    return { dateKey: d.toISOString().slice(0, 10), hour: d.getHours(), date: d };
  }
  const [, y, mo, da, hh, mm, ss] = m;
  return {
    dateKey: `${y}-${mo}-${da}`,
    hour: parseInt(hh, 10),
    date: new Date(`${y}-${mo}-${da}T${hh}:${mm}:${ss || "00"}+05:30`),
  };
}

export const lower = (s) => String(s ?? "").trim().toLowerCase();

export function searchTokens(billNo, customerName) {
  const out = new Set();
  const add = (word) => {
    const w = String(word).toLowerCase();
    if (w.length < 2) {
      if (w) out.add(w);
      return;
    }
    for (let i = 2; i <= w.length && i <= 24; i++) out.add(w.slice(0, i));
  };
  const bn = lower(billNo);
  if (bn) {
    out.add(bn);
    add(bn);
  }
  for (const word of lower(customerName).split(/[\s,._-]+/).filter(Boolean)) {
    add(word);
    if (out.size > 200) break;
  }
  return [...out];
}
