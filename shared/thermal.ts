export type ThermalConfig = Record<string, unknown>;
export type ThermalRun = {
  id: string; source: string; sourceHash: string; units: 'mm' | 'cm' | 'm';
  createdAt: string; finishedAt?: string; state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  executable: string; config: ThermalConfig; log: string; error?: string; revision?: string;
  progress?: { phase: string; progress: number; detail: string };
  files: { path: string; size: number; hash: string }[];
  result?: ThermalManifest; stale?: boolean; published?: string; publishedRevision?: string;
};
export type ThermalManifest = {
  schema_version: 1; source_sha256: string; engine_version: string;
  result: { analysis_mode?: 'steady' | 'transient'; times_s: number[]; vertices: number; frames: number; minimum_C: number; maximum_C: number;
    stats: { time_s: number; minimum_C: number; maximum_C: number; average_C: number }[];
    summary: { warnings?: string[] }; };
};
export type ThermalProbe = { ok: boolean; executable: string; version?: string; message: string };
