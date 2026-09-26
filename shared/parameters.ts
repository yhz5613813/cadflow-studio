export type ModelParameter = { name: string; label: string; type: 'number' | 'integer'; unit: 'mm' | 'cm' | 'm' | 'in' | 'deg' | 'unitless'; value: number; min: number; max: number; step?: number };
export type ParameterConstraint = { terms: Record<string, number>; min?: number; max?: number; message: string };
export type ParameterDocument = { version: 1; title: string; parameters: ModelParameter[]; constraints: ParameterConstraint[] };
export type ParameterState = { path: string; hash: string | null; document: ParameterDocument | null };
export type BuildParameters = { path: string; hash: string; values: { name: string; value: number; unit: ModelParameter['unit'] }[] };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e12;
function fields(v: Record<string, unknown>, allowed: string[]) { if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error('参数文件含有不支持的字段'); }
export function validateParameters(value: unknown): ParameterDocument {
  if (!object(value)) throw new Error('参数文件必须是对象');
  fields(value, ['version', 'title', 'parameters', 'constraints']);
  if (value.version !== 1 || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 120 || !Array.isArray(value.parameters) || !value.parameters.length || value.parameters.length > 100 || !Array.isArray(value.constraints) || value.constraints.length > 100) throw new Error('参数文件版本、标题或列表无效');
  const names = new Map<string, ModelParameter>();
  for (const raw of value.parameters) {
    if (!object(raw)) throw new Error('参数定义无效');
    fields(raw, ['name', 'label', 'type', 'unit', 'value', 'min', 'max', 'step']);
    if (typeof raw.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(raw.name) || ['constructor', 'prototype', '__proto__'].includes(raw.name) || names.has(raw.name)) throw new Error('参数名称无效或重复');
    if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 120 || !['number', 'integer'].includes(String(raw.type)) || !['mm', 'cm', 'm', 'in', 'deg', 'unitless'].includes(String(raw.unit))) throw new Error(`${raw.name}：参数类型、单位或标签无效`);
    if (!finite(raw.min) || !finite(raw.max) || raw.min > raw.max || !finite(raw.value) || raw.value < raw.min || raw.value > raw.max) throw new Error(`${raw.label}：取值必须在 ${raw.min} 到 ${raw.max} 之间`);
    if (raw.type === 'integer' && !Number.isSafeInteger(raw.value)) throw new Error(`${raw.label}：必须是整数`);
    if (raw.step !== undefined && (!finite(raw.step) || raw.step <= 0 || (raw.type === 'integer' && !Number.isSafeInteger(raw.step)))) throw new Error(`${raw.label}：步长无效`);
    names.set(raw.name, raw as ModelParameter);
  }
  for (const raw of value.constraints) {
    if (!object(raw)) throw new Error('参数关系无效');
    fields(raw, ['terms', 'min', 'max', 'message']);
    if (!object(raw.terms) || !Object.keys(raw.terms).length || typeof raw.message !== 'string' || !raw.message.trim() || raw.message.length > 300 || (raw.min === undefined && raw.max === undefined) || (raw.min !== undefined && !finite(raw.min)) || (raw.max !== undefined && !finite(raw.max)) || (raw.min !== undefined && raw.max !== undefined && Number(raw.min) > Number(raw.max))) throw new Error('参数关系的边界或说明无效');
    let sum = 0; const units = new Set<string>();
    for (const [name, coefficient] of Object.entries(raw.terms)) {
      const parameter = names.get(name);
      if (!parameter || !finite(coefficient)) throw new Error('参数关系引用了未知参数或无效系数');
      units.add(parameter.unit); sum += parameter.value * coefficient;
    }
    if (units.size !== 1) throw new Error('同一参数关系中的单位必须一致，请先统一单位');
    if (!Number.isFinite(sum) || (raw.min !== undefined && sum < Number(raw.min)) || (raw.max !== undefined && sum > Number(raw.max))) throw new Error(raw.message);
  }
  return value as ParameterDocument;
}
export function withParameterValues(doc: ParameterDocument, values: unknown): ParameterDocument {
  if (!object(values) || Object.keys(values).length !== doc.parameters.length || Object.keys(values).some(k => !doc.parameters.some(p => p.name === k))) throw new Error('必须提供完整且匹配的参数值');
  return validateParameters({ ...doc, parameters: doc.parameters.map(p => ({ ...p, value: values[p.name] })) });
}
