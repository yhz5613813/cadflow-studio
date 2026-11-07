export type CadInspectionSource = { path: string; revision?: string; sha256?: string };
export type CadInspectionVector = [number, number, number];
export type CadInspectionBox = { min: CadInspectionVector; max: CadInspectionVector; size: CadInspectionVector };
export type CadInspectionBody = {
  id: string; id_scope: 'source-file'; valid: boolean; closed: boolean;
  volume_mm3: number | null; surface_area_mm2: number | null;
  centroid_mm: CadInspectionVector | null; bbox_mm: CadInspectionBox | null;
};
export type CadInspectionSummary = {
  valid_brep: boolean; solid_count: number; material_valid: boolean;
  raw_solid_volume_sum_mm3: number | null; material_volume_mm3: number | null;
  overlap_volume_mm3: number | null; surface_area_mm2: number | null;
  surface_area_basis: 'input-brep' | 'material-union'; material_solid_count?: number;
  centroid_mm: CadInspectionVector | null; bbox_mm: CadInspectionBox | null;
  bodies: CadInspectionBody[]; warnings: string[];
};
export type CadInspectionResult = {
  schema_version: 1; method: 'occt-brep-v1';
  units: { length: 'mm'; area: 'mm2'; volume: 'mm3' };
  source: { name: string; sha256: string; input_units: string[] };
  summary: CadInspectionSummary;
  baseline?: { name: string; sha256: string; input_units: string[]; summary: CadInspectionSummary };
  comparison?: {
    status: 'succeeded' | 'unavailable' | 'failed';
    missing_volume_mm3: number | null; excess_volume_mm3: number | null;
    volume_delta_mm3: number | null; centroid_distance_mm: number | null;
    boolean_valid: boolean; volume_balance_valid: boolean;
    exported_files: { missing_material?: string; excess_material?: string };
    artifact_sha256: Record<string, string>;
    surface_area_delta_mm2?: number | null; bbox_size_delta_mm?: CadInspectionVector | null;
    warnings: string[];
  };
};
export type CadInspectionJob = {
  id: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  createdAt: string; finishedAt?: string;
  source: CadInspectionSource & { sha256: string };
  baseline?: CadInspectionSource & { sha256: string };
  outputPath: string; density_kg_m3?: number;
  result?: CadInspectionResult; log: string; error?: string;
  stale?: boolean; staleInputs?: Array<'source' | 'baseline'>;
};
