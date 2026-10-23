export type CylinderRevision = number | string;
export type CylinderObject = {
  id: string; name: string; kind: 'skin' | 'flange' | 'longitudinal' | 'ring';
  end?: 'bottom' | 'top';
  thickness_mm?: number; width_mm?: number; height_mm?: number;
  hole_count?: number; hole_diameter_mm?: number; bolt_circle_mm?: number;
  phase_deg?: number; angle_deg?: number; z_mm?: number;
};
export type CylinderObjectModel = {
  schema_version: 1; units: 'mm'; diameter_mm: number; height_mm: number;
  components: CylinderObject[];
};
export type CylinderField = {
  key: keyof CylinderObject | 'diameter_mm'; label: string; unit: string;
  positive?: boolean; integer?: boolean; step: number;
};
export const GLOBAL_FIELDS: CylinderField[] = [
  { key: 'diameter_mm', label: '筒体外径', unit: 'mm', positive: true, step: 1 },
  { key: 'height_mm', label: '总高', unit: 'mm', positive: true, step: 1 },
];
export const OBJECT_GROUPS: { kind: CylinderObject['kind']; label: string }[] = [
  { kind: 'skin', label: '蒙皮' }, { kind: 'flange', label: '端框' },
  { kind: 'longitudinal', label: '纵筋' }, { kind: 'ring', label: '环筋' },
];
export function objectFields(object: CylinderObject): CylinderField[] {
  if (object.kind === 'skin') return [{ key: 'thickness_mm', label: '厚度', unit: 'mm', positive: true, step: 0.1 }];
  if (object.kind === 'flange') return [
    { key: 'thickness_mm', label: '厚度', unit: 'mm', positive: true, step: 0.5 },
    { key: 'width_mm', label: '径向宽度', unit: 'mm', positive: true, step: 1 },
    { key: 'hole_count', label: '孔数', unit: '个', positive: true, integer: true, step: 1 },
    { key: 'hole_diameter_mm', label: '孔径', unit: 'mm', positive: true, step: 0.5 },
    { key: 'bolt_circle_mm', label: '孔分布圆直径', unit: 'mm', positive: true, step: 1 },
    { key: 'phase_deg', label: '孔阵列转角', unit: '°', step: 1 },
  ];
  return [
    { key: 'width_mm', label: '宽度', unit: 'mm', positive: true, step: 0.5 },
    { key: 'height_mm', label: '径向高度', unit: 'mm', positive: true, step: 0.5 },
    object.kind === 'ring'
      ? { key: 'z_mm', label: '中心高度', unit: 'mm', step: 1 }
      : { key: 'angle_deg', label: '周向角度', unit: '°', step: 1 },
  ];
}
export type CylinderEdits = Record<string, string>;
export const fieldKey = (objectId: string, field: string) => objectId + ':' + field;
export function fieldText(value: unknown): string {
  // Keep the exact saved value through view/edit/save; formatting must not move a ring.
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}
export function setCylinderEdit(edits: CylinderEdits, key: string, text: string, original: unknown): CylinderEdits {
  const next = { ...edits };
  // Equivalent numeric input should not unnecessarily invalidate the CAD publication.
  if (text.trim() !== '' && Number.isFinite(Number(text)) && Number(text) === original) delete next[key];
  else next[key] = text;
  return next;
}
export function applyCylinderEdits(model: CylinderObjectModel, edits: CylinderEdits) {
  const next = structuredClone(model);
  const issues: { key: string; message: string }[] = [];
  const known = new Set<string>();
  const apply = (target: Record<string, unknown>, id: string, name: string, fields: CylinderField[]) => {
    for (const field of fields) {
      const key = fieldKey(id, field.key); known.add(key);
      if (!(key in edits)) continue;
      const raw = edits[key].trim(); const value = Number(raw);
      if (!raw || !Number.isFinite(value) || (field.positive && value <= 0) || (field.integer && !Number.isInteger(value))) {
        issues.push({ key, message: name + ' · ' + field.label + (field.integer ? '须为正整数' : field.positive ? '须为大于 0 的数值' : '须为有效数值') });
      } else target[field.key] = value;
    }
  };
  apply(next as unknown as Record<string, unknown>, '$global', '整体尺寸', GLOBAL_FIELDS);
  for (const object of next.components) apply(object as unknown as Record<string, unknown>, object.id, object.name, objectFields(object));
  for (const key of Object.keys(edits)) if (!known.has(key)) issues.push({ key, message: '对象已变化，请重新载入参数' });
  return { model: next, issues };
}
export function canUseCylinderPublication(revision: CylinderRevision | undefined, publishedRevision: CylinderRevision | undefined, hasEdits: boolean) {
  return revision !== undefined && publishedRevision !== undefined && revision === publishedRevision && !hasEdits;
}
