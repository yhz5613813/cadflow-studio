import type { Response } from 'express';
import type { StudioEvent } from '../shared/types.js';
export class Events {
  private counter = Date.now();
  private streams = new Map<string, Set<Response>>();
  private history = new Map<string, StudioEvent[]>();
  emit(project: string, type: string, data: Record<string, unknown>) {
    const event = { id: ++this.counter, type, data };
    const history = this.history.get(project) ?? [];
    history.push(event); if (history.length > 300) history.shift(); this.history.set(project, history);
    for (const res of this.streams.get(project) ?? []) res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  connect(project: string, response: Response, after: number) {
    response.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    response.write(': connected\n\n');
    if (after) for (const event of this.history.get(project) ?? []) if (event.id > after) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    const set = this.streams.get(project) ?? new Set(); set.add(response); this.streams.set(project, set);
    const timer = setInterval(() => response.write(': heartbeat\n\n'), 15000);
    response.on('close', () => { clearInterval(timer); set.delete(response); if (!set.size) this.streams.delete(project); });
  }
}
