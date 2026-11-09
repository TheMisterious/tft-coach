// The status bar: one label per app state, and a hotkey label that matches
// what the hotkey does (shows or hides the window — coachv has no overlay).

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusBar } from '../src/ui/desktop/StatusBar';

// Rendering to markup runs no effects, so the hotkey read (and Overwolf) is
// never touched and the binding shows as "Not set".

describe('StatusBar', () => {
  it('says when a match is being played and when not', () => {
    expect(renderToStaticMarkup(<StatusBar status="in_match" />)).toContain('In TFT match');
    expect(renderToStaticMarkup(<StatusBar status="no_game" />)).toContain('Not in match');
  });

  it('labels the hotkey by what it does', () => {
    const html = renderToStaticMarkup(<StatusBar status="no_game" />);
    expect(html).toContain('Show/hide coachv:');
    expect(html).not.toMatch(/overlay/i);
  });
});
