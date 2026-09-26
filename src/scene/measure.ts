import type { MeshMetrics } from '../../shared/measurements';
import type { MetricInput } from './mesh-metrics';
export function measureInWorker(input: MetricInput, signal: AbortSignal): Promise<MeshMetrics> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./measurement.worker.ts', import.meta.url), { type: 'module' });
    const finish = (error?: Error, value?: MeshMetrics) => { clearTimeout(timeout); signal.removeEventListener('abort', abort); worker.terminate(); if (error) reject(error); else resolve(value!); };
    const abort = () => finish(new Error('测量已取消'));
    const timeout = setTimeout(() => finish(new Error('测量超过 30 秒，请选择更小的部件或面')), 30000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => finish(event.data.error ? new Error(event.data.error) : undefined, event.data.result);
    worker.onerror = () => finish(new Error('测量线程失败，请重试'));
    try { worker.postMessage(input, [input.positions.buffer, input.indices.buffer]); } catch (error) { finish(error as Error); }
  });
}
