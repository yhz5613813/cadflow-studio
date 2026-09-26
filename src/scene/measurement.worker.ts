import { measureMesh, type MetricInput } from './mesh-metrics';
self.onmessage = (event: MessageEvent<MetricInput>) => {
  try { self.postMessage({ result: measureMesh(event.data) }); }
  catch (error) { self.postMessage({ error: (error as Error).message }); }
};
