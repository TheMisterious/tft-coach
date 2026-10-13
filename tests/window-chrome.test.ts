// Native windows have no OS title bar.
//
// The desktop window is an Overwolf NATIVE window (native_window + desktop_only
// — both are required, and native_window is silently ignored without
// desktop_only, which is exactly what Overwolf QA flagged on v0.0.1). Overwolf
// creates such windows with no frame and no minimise/maximise/close buttons,
// and its own guidance is to implement the header in HTML/CSS.
//
// That makes src/ui/desktop/TitleBar.tsx load-bearing: without it the window
// cannot be moved, minimised, maximised or closed by any means. This was a real
// regression once already — adding desktop_only to satisfy QA turned a working
// standard Overwolf window into a native one with no chrome at all. These
// assertions tie the two facts together so the next person to touch either side
// gets a failing test rather than an unclosable window.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');

const manifest = JSON.parse(
  readFileSync(path.join(ROOT, 'public', 'manifest.json'), 'utf-8')
) as {
  data: { windows: Record<string, Record<string, unknown>> };
};

const desktop = manifest.data.windows.desktop;

describe('desktop window chrome', () => {
  it('native_window is paired with desktop_only', () => {
    // Overwolf ignores native_window without this, which is how v0.0.1 shipped
    // a styled Overwolf window while the manifest claimed a native one.
    if (desktop.native_window) {
      expect(desktop.desktop_only, 'native_window requires desktop_only').toBe(true);
    }
  });

  it('a native desktop window ships its own header component', () => {
    if (!desktop.native_window) return;

    const index = readFileSync(path.join(ROOT, 'src', 'ui', 'desktop', 'index.tsx'), 'utf-8');
    expect(index, 'TitleBar must be imported by the desktop entry point').toContain("from './TitleBar'");
    expect(index, 'TitleBar must actually be rendered').toMatch(/<TitleBar\s*\/?>/);
  });

  it('the header wires up move, minimize, maximize, restore and close', () => {
    const titleBar = readFileSync(path.join(ROOT, 'src', 'ui', 'desktop', 'TitleBar.tsx'), 'utf-8');
    for (const api of ['dragMove', 'minimize', 'maximize', 'restore', 'close']) {
      expect(titleBar, `TitleBar must call overwolf.windows.${api}`).toContain(`overwolf.windows.${api}(`);
    }
  });

  it('does not declare flags that do nothing on a native window', () => {
    // show_minimize / show_maximize only apply to standard (non-native)
    // Overwolf windows. Declaring them here would imply chrome the window can
    // never render — the same class of finding as the unused Tray permission.
    if (!desktop.native_window) return;
    expect(desktop.show_minimize).toBeUndefined();
    expect(desktop.show_maximize).toBeUndefined();
  });
});
