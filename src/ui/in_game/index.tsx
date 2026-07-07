// In-game overlay entry point — STATIC content only (Riot compliance requirement).
// Shows item recipes and trait activation thresholds.
// NO live board data. NO suggestions based on current game state.

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InGameOverlay } from './InGameOverlay';

declare const overwolf: any;

function InGameApp() {
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    // Listen for toast messages from the background window.
    overwolf.windows.onMessageReceived.addListener((msg: any) => {
      if (msg.id === 'toast' && msg.content) {
        setToast(msg.content as string);
        setTimeout(() => setToast(null), 5000);
      }
    });
  }, []);

  return (
    <>
      <InGameOverlay />
      {toast && (
        <div style={{
          position: 'fixed', bottom: 16, right: 16,
          background: '#313244', color: '#cdd6f4',
          padding: '10px 16px', borderRadius: 8,
          fontSize: 13, fontFamily: 'Segoe UI, system-ui, sans-serif',
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          zIndex: 9999,
        }}>
          {toast}
        </div>
      )}
    </>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<InGameApp />);
}
