import type { ComponentType } from "react";
import { makeSummary } from "./mock-data";

let captured: ComponentType<any> | null = null;
export function getCaptured() { return captured; }

export function definePluginApp(setup: (app: any) => void) {
  const app = {
    slots: { navPanel: (cfg: any) => { captured = cfg.component; } },
    contentScripts: { register: () => {} },
    composer: { customize: () => {} },
  };
  setup(app);
  return app;
}

export function useRpc<T>() {
  return {
    call: async (_method: string, input: any) => makeSummary(input?.range ?? "7d"),
  };
}
export function useRealtime() {}
export function useRealtimeConnectionState() { return "connected"; }
export function useSettings() { return { values: {}, isLoading: false }; }
export function useBbContext() { return { projectId: null, threadId: null }; }
export function useBbNavigate() { return {}; }
