import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], resolve: { dedupe: ['@codemirror/state', '@codemirror/view'] }, server: { host: '127.0.0.1' }, build: { outDir: 'dist', chunkSizeWarningLimit: 1500 } });
