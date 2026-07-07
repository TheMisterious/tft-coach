// Safely parse a potentially-stringified GEP payload field.
//
// WHY THIS EXISTS: Overwolf's GEP wraps almost every non-trivial value as a
// JSON string inside a string. Sometimes it's double-encoded. Sometimes the
// outer value is already an object. Miss this once and your whole ledger is corrupt.
//
// Returns `fallback` on any parse failure — never throws.

export function safeParseGep<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === 'object') {
    // GEP sometimes sends "{}" instead of "[]" for an empty list field
    // (e.g. shop_pieces on a PVE/carousel round). Don't hand callers a
    // shape they didn't ask for — an array consumer would crash on spread.
    if (Array.isArray(fallback) && !Array.isArray(raw)) return fallback;
    return raw as T;       // already parsed by CEF
  }
  if (typeof raw !== 'string') return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') {
      // Might be double-encoded JSON; try once more, but if the inner value is
      // itself a plain string (e.g. game_mode="tft"), return it directly.
      try { return JSON.parse(parsed); } catch { return parsed as T; }
    }
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
    return parsed;
  } catch {
    // raw is a plain non-JSON string (e.g. pseudo_match_id, game_mode).
    // Return it directly rather than discarding as a parse failure.
    return raw as T;
  }
}
