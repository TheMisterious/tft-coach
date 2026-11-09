// Player Trends below the match threshold: progress plus a labelled example.
//
// Overwolf QA asked that the page show "how this would look even if there is
// no data". The example must stay visibly separate from the player's own
// numbers, and disappear once a real profile can be computed.

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlayerTrendsView } from '../src/ui/desktop/PlayerTrendsView';
import { SAMPLE_PLAYER_PROFILE } from '../src/ui/desktop/player-trends-sample';
import { TRENDS_MIN_MATCHES } from '../src/profile/trend-model';
import type { PlayerProfile } from '../src/shared/types';

function render(profile: PlayerProfile | null): string {
  return renderToStaticMarkup(<PlayerTrendsView profile={profile} />);
}

function profileWith(sampleSize: number, confidence: PlayerProfile['confidence']): PlayerProfile {
  return {
    computedAt: 1,
    sampleSize,
    confidence,
    correlations: [],
    clusters: [],
    skippedStaleSchemaCount: 0,
  };
}

describe('PlayerTrendsView', () => {
  it('shows progress and the example before any match is saved', () => {
    const html = render(null);
    expect(html).toContain(`0 of ${TRENDS_MIN_MATCHES} matches recorded`);
    expect(html).toContain('Example');
    expect(html).toContain('not your data');
    // Every section the real page can hold appears in the example.
    expect(html).toContain('What correlates with your placement');
    expect(html).toContain('Strongest combined predictors');
    expect(html).toContain('Play-style patterns');
  });

  it('counts real progress while the profile is still insufficient', () => {
    const html = render(profileWith(7, 'insufficient_data'));
    expect(html).toContain(`7 of ${TRENDS_MIN_MATCHES} matches recorded`);
    expect(html).toContain('aria-valuenow="7"');
    expect(html).toContain('Example');
  });

  it('drops the example once a real profile exists', () => {
    const html = render(profileWith(TRENDS_MIN_MATCHES, 'exploratory'));
    expect(html).not.toContain('Example');
    expect(html).not.toContain('matches recorded');
    expect(html).toContain(`${TRENDS_MIN_MATCHES} matches analyzed`);
  });

  it('the example profile fills every section it is meant to show', () => {
    expect(SAMPLE_PLAYER_PROFILE.correlations.some(c => c.meaningfulAtN)).toBe(true);
    expect(SAMPLE_PLAYER_PROFILE.regression).toBeDefined();
    expect(SAMPLE_PLAYER_PROFILE.clusters.length).toBeGreaterThan(0);
  });
});
