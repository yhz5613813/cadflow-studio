import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
export function runProcess(executable: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeout: number; output: (text: string) => void }) {
  return new Promise<{ code: number | null; timedOut: boolean }>((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error('执行已取消')); return; }
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|home|userprofile|lang|lc_.*|processor_architecture|processor_architew6432|ld_library_path|dyld_library_path|cadflow_core_library)$/i.test(key)) env[key] = value;
    Object.assign(env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' });
    const child = spawn(executable, args, { cwd: process.platform === 'win32' ? path.toNamespacedPath(options.cwd) : options.cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let finished = false, timedOut = false, stopping = false;
    const stop = () => {
      if (finished || stopping || !child.pid) return; stopping = true;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
        killer.on('error', () => { if (!finished) child.kill(); });
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeout);
    options.signal?.addEventListener('abort', stop, { once: true });
    const cleanup = () => { finished = true; clearTimeout(timer); options.signal?.removeEventListener('abort', stop); };
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    child.stdout.on('data', chunk => options.output(stdout.write(chunk)));
    child.stderr.on('data', chunk => options.output(stderr.write(chunk)));
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => { options.output(stdout.end() + stderr.end()); cleanup(); resolve({ code, timedOut }); });
    if (options.signal?.aborted) stop();
  });
}
