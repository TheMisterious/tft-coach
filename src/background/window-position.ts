// Clamps a saved window position/size back onto a real monitor before it's shown.
// Needed because Overwolf persists window rects across sessions, but a rect saved
// on a since-unplugged/resized monitor can leave the window fully off-screen and
// unreachable (no title bar visible to drag it back).

declare const overwolf: any;

interface MonitorRect {
  x: number;
  y: number;
  width: number;
  height: number;
  is_primary?: boolean;
}

interface WindowRect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

function centerInsideMonitor(win: WindowRect, m: MonitorRect): boolean {
  const cx = win.left + win.width / 2;
  const cy = win.top + win.height / 2;
  return cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height;
}

// Repositions `win` onto a real monitor if its saved rect's center point no
// longer lands on any currently-connected display, then calls `done`.
// If the window is already fine, `done` is called immediately with no API calls.
export function ensureWindowOnScreen(win: WindowRect, done: () => void): void {
  overwolf.utils.getMonitorsList((result: any) => {
    const monitors: MonitorRect[] = result?.success ? result.displays ?? [] : [];
    if (!monitors.length) {
      done();
      return;
    }

    const isOnScreen = monitors.some((m) => centerInsideMonitor(win, m));

    if (isOnScreen) {
      done();
      return;
    }

    console.warn('[bg] saved window rect is off-screen for current monitor layout — reclamping', win);

    const primary = monitors.find((m) => m.is_primary) ?? monitors[0];
    const width = Math.min(win.width, primary.width);
    const height = Math.min(win.height, primary.height);
    const left = Math.min(Math.max(win.left, primary.x), primary.x + primary.width - width);
    const top = Math.min(Math.max(win.top, primary.y), primary.y + primary.height - height);

    overwolf.windows.changePosition(win.id, Math.round(left), Math.round(top), () => {
      overwolf.windows.changeSize(win.id, Math.round(width), Math.round(height), () => done());
    });
  });
}
