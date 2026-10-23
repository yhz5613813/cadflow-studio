/** Stable identity stored on assembly occurrences, independent of tessellation UUIDs. */
export function cylinderObjectId(name: string): string | undefined {
  return /^(skin|frame\.(?:bottom|top)|longitudinal\.\d{3}|ring\.\d{3})(?:\s*\||$)/.exec(name.trim())?.[1];
}

/** Some OCCT builds return UTF-8 labels as Latin-1. Leave real Unicode and invalid UTF-8 untouched. */
export function decodeStepLabel(value: string): string {
  if (!/[\u0080-\u00ff]/.test(value) || /[^\u0000-\u00ff]/.test(value)) return value;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(value, char => char.charCodeAt(0))); }
  catch { return value; }
}

export function cylinderObjectName(label: string): string {
  const decoded = decodeStepLabel(label);
  const id = cylinderObjectId(decoded);
  if (!id) return decoded;
  const name = decoded.slice(id.length).replace(/^\s*\|\s*/, '').trim();
  if (name) return name;
  if (id === 'skin') return '蒙皮';
  if (id === 'frame.bottom') return '下端框';
  if (id === 'frame.top') return '上端框';
  return (id.startsWith('longitudinal.') ? '纵筋 ' : '环筋 ') + Number(id.split('.')[1]).toString().padStart(2, '0');
}

export function cylinderMeshId<T extends { id: string; cylinderObjectId?: string }>(meshes: T[], objectId: string): string | undefined {
  return meshes.find(mesh => mesh.cylinderObjectId === objectId)?.id;
}
