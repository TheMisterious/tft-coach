// Registers TFT GEP features with retry logic.
// MUST be called ONLY from the background window — Overwolf's docs are explicit.
// Features can be temporarily unavailable right after game launch, so we retry.

declare const overwolf: any; // injected by Overwolf's CEF host

const TFT_FEATURES = [
  'gep_internal',
  'game_info',
  'me',
  'match_info',
  'roster',
  'store',
  'board',
  'bench',
  'augments',
] as const;

export async function registerTftFeatures(maxRetries = 15): Promise<boolean> {
  for (let i = 1; i <= maxRetries; i++) {
    const result = await new Promise<any>(
      resolve => overwolf.games.events.setRequiredFeatures(TFT_FEATURES, resolve)
    );

    // Handle both new format { success: boolean } and old format { status: string }
    const ok = result?.success === true || result?.status === 'success';
    if (ok && (result?.supportedFeatures?.length ?? 0) > 0) {
      console.log('[gep] features registered:', JSON.stringify(result.supportedFeatures));
      return true;
    }

    console.warn(`[gep] attempt ${i}/${maxRetries} failed — success=${result?.success} status=${result?.status} features=${result?.supportedFeatures?.length ?? 0}, retrying in 3s…`);
    await new Promise(r => setTimeout(r, 3000));
  }

  console.error('[gep] failed to register features after all retries');
  return false;
}

// Fetch the current game state snapshot after feature registration.
// Overwolf does not replay missed onInfoUpdates2 events, so we call getInfo
// immediately after setRequiredFeatures to capture board/match state that was
// already set before our listeners attached. Also reused at match-end (see
// background/main.ts runCoachingPipeline) to pull the authoritative me.placement
// directly from GEP's live state, rather than trusting whichever push event
// (match_outcome vs. placement) happened to arrive first.
// Returns a promise so callers that need the data flushed to the ledger before
// proceeding (e.g. the match-end pipeline) can await it.
export function fetchAndDispatchInitialState(
  onInfoUpdate: (feature: string, key: string, value: unknown) => void
): Promise<void> {
  return new Promise(resolve => {
    overwolf.games.events.getInfo((result: any) => {
      // Overwolf returns data under `res` (older SDK) or `info` (newer SDK).
      const payload = result?.res ?? result?.info;
      if (!result?.success || !payload) {
        console.warn('[gep] getInfo returned no data:', result);
        resolve();
        return;
      }
      console.log('[gep] getInfo raw payload:', JSON.stringify(payload));
      const res = payload as Record<string, Record<string, unknown>>;
      let count = 0;
      for (const [feature, data] of Object.entries(res)) {
        if (!data || typeof data !== 'object') continue;
        for (const [key, value] of Object.entries(data)) {
          console.log(`[gep] initial state: ${feature}.${key} =`, value);
          onInfoUpdate(feature, key, value);
          count++;
        }
      }
      console.log(`[gep] initial state dispatched from getInfo (${count} keys)`);
      resolve();
    });
  });
}
