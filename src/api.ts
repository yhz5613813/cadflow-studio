import type { Artifact, ChatGPTLogin, Message, Plugin, Project, Settings, Status, Revision, RevisionComparison, RevisionFileDiff } from '../shared/types';
import type { ReviewDocument, ReviewNote } from '../shared/types';
import type { BuildRun, RuntimeProbe } from '../shared/types';
import type { ParameterState } from '../shared/parameters';
import type { Measurement, MeasurementDocument } from '../shared/measurements';
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `请求失败 (${response.status})`); }
  return response.json();
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const api = {
  measurements: (id: string) => request<MeasurementDocument>(`/api/projects/${id}/measurements`),
  saveMeasurement: (id: string, etag: string, measurement: Pick<Measurement, 'anchor' | 'metrics'>) => request<MeasurementDocument>(`/api/projects/${id}/measurements`, json('POST', { etag, measurement })),
  deleteMeasurement: (id: string, etag: string, measurement: string) => request<MeasurementDocument>(`/api/projects/${id}/measurements/${encodeURIComponent(measurement)}`, json('DELETE', { etag })),
  runtime: () => request<{ executable: string }>('/api/runtime'),
  probeRuntime: (executable: string) => request<RuntimeProbe>('/api/runtime/probe', json('POST', { executable })),
  saveRuntime: (executable: string) => request<RuntimeProbe>('/api/runtime', json('PUT', { executable })),
  builds: (id: string) => request<BuildRun[]>(`/api/projects/${id}/builds`),
  startBuild: (id: string, source: string, expectedSource: string, expectedParameters?: string | null) => request<BuildRun>(`/api/projects/${id}/builds`, json('POST', { source, expectedSource, expectedParameters })),
  parameters: (id: string, source: string) => request<ParameterState>(`/api/projects/${id}/parameters?source=${encodeURIComponent(source)}`),
  saveParameters: (id: string, source: string, hash: string, values: Record<string, number>) => request<ParameterState>(`/api/projects/${id}/parameters`, json('PUT', { source, hash, values })),
  plateTemplate: (id: string) => request<{ source: string }>(`/api/projects/${id}/templates/plate`, json('POST', {})),
  cancelBuild: (id: string, run: string) => request<BuildRun>(`/api/projects/${id}/builds/${run}/cancel`, json('POST', {})),
  publishBuild: (id: string, run: string) => request<{ path: string }>(`/api/projects/${id}/builds/${run}/publish`, json('POST', {})),
  buildFileUrl: (id: string, run: string, file: string) => `/api/projects/${id}/builds/${run}/file?path=${encodeURIComponent(file)}`,
  status: () => request<Status>('/api/status'), projects: () => request<Project[]>('/api/projects'),
  createProject: (name: string) => request<Project>('/api/projects', json('POST', { name })),
  messages: (id: string) => request<Message[]>(`/api/projects/${id}/messages`),
  files: (id: string) => request<Artifact[]>(`/api/projects/${id}/files`),
  reviews: (id: string) => request<ReviewDocument>(`/api/projects/${id}/annotations`),
  addReview: (id: string, etag: string, note: Omit<ReviewNote, 'id' | 'createdAt' | 'updatedAt'>) => request<ReviewDocument>(`/api/projects/${id}/annotations`, json('POST', { etag, note })),
  updateReview: (id: string, noteId: string, etag: string, note: Pick<ReviewNote, 'text' | 'intent' | 'status' | 'priority'>) => request<ReviewDocument>(`/api/projects/${id}/annotations/${encodeURIComponent(noteId)}`, json('PATCH', { etag, note })),
  removeReview: (id: string, noteId: string, etag: string) => request<ReviewDocument>(`/api/projects/${id}/annotations/${encodeURIComponent(noteId)}`, json('DELETE', { etag })),
  fileUrl: (id: string, file: string) => `/api/projects/${id}/file?path=${encodeURIComponent(file)}`,
  source: async (id: string, file: string) => { const r = await fetch(`${api.fileUrl(id, file)}&text=1`); if (!r.ok) throw new Error((await r.json()).error); return r.text(); },
  saveSource: (id: string, file: string, text: string, baseText?: string | null) => request(`/api/projects/${id}/file`, json('PUT', { path: file, text, baseText })),
  history: (id: string) => request<Revision[]>(`/api/projects/${id}/history`),
  checkpoint: (id: string, label: string) => request<Revision>(`/api/projects/${id}/history`, json('POST', { label })),
  compareRevision: (id: string, revision: string) => request<RevisionComparison>(`/api/projects/${id}/history/${revision}/compare`),
  revisionDiff: (id: string, revision: string, file: string) => request<RevisionFileDiff>(`/api/projects/${id}/history/${revision}/diff?path=${encodeURIComponent(file)}`),
  revisionFileUrl: (id: string, revision: string, file: string) => `/api/projects/${id}/history/${revision}/file?path=${encodeURIComponent(file)}`,
  restoreRevision: (id: string, revision: string, fingerprint: string) => request(`/api/projects/${id}/history/${revision}/restore`, json('POST', { fingerprint })),
  prompt: (id: string, text: string, selection?: unknown) => request(`/api/projects/${id}/prompt`, json('POST', { text, selection })),
  stop: (id: string) => request(`/api/projects/${id}/stop`, json('POST', {})),
  upload: (id: string, file: File) => { const form = new FormData(); form.set('file', file); return request<{ path: string; name: string }>(`/api/projects/${id}/upload`, { method: 'POST', body: form }); },
  plugins: () => request<Plugin[]>('/api/plugins'),
  install: (source: string) => request<Plugin>('/api/plugins', json('POST', { source })),
  enable: (id: string, enabled: boolean) => request<Plugin>(`/api/plugins/${id}`, json('PATCH', { enabled })),
  remove: (id: string) => request(`/api/plugins/${id}`, { method: 'DELETE' }),
  settings: (settings: Settings) => request('/api/settings', json('PUT', settings)),
  connectOpenAI: (apiKey: string) => request('/api/provider/openai', json('POST', { apiKey })),
  chatGPTLogin: () => request<ChatGPTLogin>('/api/auth/chatgpt'),
  startChatGPTLogin: () => request<ChatGPTLogin>('/api/auth/chatgpt', json('POST', {})),
  submitChatGPTCallback: (id: string, callbackUrl: string) => request(`/api/auth/chatgpt/${encodeURIComponent(id)}/callback`, json('POST', { callbackUrl })),
  cancelChatGPTLogin: (id: string) => request<ChatGPTLogin>(`/api/auth/chatgpt/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  connectProvider: (baseUrl: string, model: string, apiKey: string) => request('/api/provider', json('POST', { baseUrl, model, apiKey })),
};
