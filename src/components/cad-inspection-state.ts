import type { CadInspectionJob, CadInspectionSource, CadInspectionSummary } from '../../shared/cad-inspections';

export function cadMassKg(summary: CadInspectionSummary | undefined, density: number | undefined): number | null {
  const volume = summary?.material_volume_mm3;
  return summary?.material_valid && typeof volume === 'number' && Number.isFinite(volume) && volume >= 0
    && typeof density === 'number' && Number.isFinite(density) && density > 0
    ? volume * 1e-9 * density : null;
}

export function cadSourceKey(source: Pick<CadInspectionSource, 'path' | 'revision'> | undefined): string {
  return source ? JSON.stringify([source.path, source.revision || '']) : '';
}

export function cadInspectionMatches(job: CadInspectionJob, source: CadInspectionSource, baseline?: CadInspectionSource, density?: number, currentHash?: string): boolean {
  return !job.stale && cadSourceKey(job.source) === cadSourceKey(source) && cadSourceKey(job.baseline) === cadSourceKey(baseline)
    && (job.density_kg_m3 ?? undefined) === density && (!currentHash || job.source.sha256 === currentHash.replace(/^sha256:/, ''));
}
