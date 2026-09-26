import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { app, builds, thermal } = await createApp(path.resolve(process.env.STUDIO_DATA_DIR || path.join(root, '.studio')));
if (process.argv.includes('--dev')) {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
}
const port = Number(process.env.STUDIO_PORT || 4317);
app.listen(port, '127.0.0.1', () => console.log(`CadFlow Studio → http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void Promise.allSettled([builds.dispose(), thermal.dispose()]).finally(() => process.exit(0)); });
