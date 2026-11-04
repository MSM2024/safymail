export interface CatchAllState {
  enabled?: boolean;
  actions?: Array<{ type?: string; value?: string[] }>;
}
export type CatchAllDecision = "already_configured" | "create" | "conflict";

export function assessCatchAll(current: CatchAllState | null, workerName: string): CatchAllDecision {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(workerName)) {
    throw new Error("Invalid Worker name.");
  }
  if (!current) return "create";
  const workerAction = current.actions?.find(action => action.type === "worker");
  if (current.enabled === true && workerAction?.value?.includes(workerName)) return "already_configured";
  if (current.enabled === true) return "conflict";
  const inactiveDefault = !current.actions?.length || current.actions.every(action => action.type === "drop");
  return inactiveDefault ? "create" : "conflict";
}
