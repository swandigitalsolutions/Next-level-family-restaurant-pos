/**
 * Denormalized query fields for `bills` (FIRESTORE-SCHEMA.md §7).
 * Replaces the Flask `LOWER(bill_no)/LOWER(customer_name) LIKE '%q%'` search —
 * see the Limitations note: interior substrings do not match, word-prefixes do.
 */

export const lower = (s: unknown): string => String(s ?? "").trim().toLowerCase();

/**
 * Tokens for the orders search (`searchTokens array-contains q`):
 *   - the exact lowercased bill number (e.g. "food-000123")
 *   - every running prefix (>= 2 chars) of the bill number
 *   - for each word of the customer name: every running prefix (>= 2 chars)
 * Capped so a pathological name can't blow up the doc.
 */
export function searchTokens(billNo: string, customerName: string): string[] {
  const out = new Set<string>();
  const add = (word: string) => {
    const w = word.toLowerCase();
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
