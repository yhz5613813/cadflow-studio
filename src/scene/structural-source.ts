import type { Artifact } from '../../shared/types';

export function chooseStructuralSource(files: Artifact[], current: string, publishedSource?: string, explicitlySelected = false): string {
  if (explicitlySelected) return current;
  const steps = files.filter(file => file.kind === 'model' && /\.step$/i.test(file.name) && !file.path.startsWith('structural/') && !file.path.startsWith('studio/cad-inspections/'));
  if (publishedSource && steps.some(file => file.path === publishedSource)) return publishedSource;
  return current || steps[0]?.path || '';
}
