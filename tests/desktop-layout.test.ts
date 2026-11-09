// The desktop window itself never scrolls.
//
// Overwolf QA flagged "the main window is scrollable" on 0.1.1. The cause was
// CoachingReportView's root at height: 100vh inside the content area, which
// the title bar, status bar, tabs and ad banner already shrink — the view
// overflowed by their height and the content area's overflow: auto scrolled
// the whole report. Views fill their slot (100%) and scroll their own panes.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const DESKTOP = path.resolve(__dirname, '..', 'src', 'ui', 'desktop');

describe('desktop window layout', () => {
  it('no view inside the window sizes itself to the viewport', () => {
    // index.tsx's outer column is the one element that may be viewport-tall.
    const offenders = readdirSync(DESKTOP)
      .filter(f => f.endsWith('.module.css'))
      .filter(f => /:\s*100vh\b/.test(readFileSync(path.join(DESKTOP, f), 'utf-8')));
    expect(offenders, 'use height: 100% so the view fits between the chrome and the ad').toEqual([]);
  });

  it('the content area between the tabs and the ad does not scroll', () => {
    const index = readFileSync(path.join(DESKTOP, 'index.tsx'), 'utf-8');
    expect(index).toMatch(/flex: 1, overflow: 'hidden', minHeight: 0/);
    expect(index).not.toMatch(/overflow: 'auto'/);
  });

  it('each view scrolls its own panes instead', () => {
    const report = readFileSync(path.join(DESKTOP, 'CoachingReportView.module.css'), 'utf-8');
    const trends = readFileSync(path.join(DESKTOP, 'PlayerTrendsView.module.css'), 'utf-8');
    expect(report).toMatch(/\.sidebar \{[^}]*overflow-y: auto/);
    expect(report).toMatch(/\.main \{[^}]*overflow-y: auto/);
    expect(trends).toMatch(/\.root \{[^}]*height: 100%;[^}]*overflow-y: auto/);
  });
});
