// Zustand store — shared state between desktop components.
// The background window pushes reports via sendMessage; this store receives them.

import { create } from 'zustand';
import type { CoachingReport, MatchSummary, AppStatus } from '../shared/types';

interface AppStore {
  currentReport:  CoachingReport | null;
  matchHistory:   MatchSummary[];
  isLoading:      boolean;
  appStatus:      AppStatus;

  setCurrentReport: (report: CoachingReport) => void;
  setMatchHistory:  (history: MatchSummary[]) => void;
  setIsLoading:     (loading: boolean) => void;
  setAppStatus:     (status: AppStatus) => void;
}

export const useAppStore = create<AppStore>(set => ({
  currentReport: null,
  matchHistory:  [],
  isLoading:     false,
  appStatus:     'no_game',

  setCurrentReport: report  => set({ currentReport: report }),
  setMatchHistory:  history => set({ matchHistory: history }),
  setIsLoading:     loading => set({ isLoading: loading }),
  setAppStatus:     status  => set({ appStatus: status }),
}));
