import { randomUUID } from 'node:crypto';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ChatGPTLogin } from '../shared/types.js';
import { HttpError } from './storage.js';

// Only public progress crosses the HTTP boundary; pi owns token storage/refresh.
export class ChatGPTAuth {
  private state: ChatGPTLogin = { phase: 'idle' };
  private controller?: AbortController;
  private task?: Promise<void>;
  private manualReply?: (value: string) => void;
  constructor(private runtime: () => Promise<Pick<ModelRuntime, 'login' | 'getModel' | 'completeSimple'>>, private selectModel: () => Promise<void>, private timeoutMs = 15 * 60 * 1000) {}
  get active() { return ['starting', 'waiting', 'verifying'].includes(this.state.phase); }
  status(): ChatGPTLogin { return { ...this.state }; }
  start(): ChatGPTLogin {
    if (this.active) return this.status();
    const controller = new AbortController(); this.controller = controller;
    this.state = { id: randomUUID(), phase: 'starting', message: '正在准备浏览器授权…' };
    this.task = this.run(controller);
    return this.status();
  }
  async cancel(id: string) {
    if (id !== this.state.id) throw new HttpError(409, '登录状态已更新，请刷新后重试');
    this.controller?.abort(); await this.task;
    return this.status();
  }
  submitCallback(id: string, callbackUrl: string) {
    if (id !== this.state.id || !this.manualReply || !this.state.verificationUrl) throw new HttpError(409, '当前没有等待中的浏览器授权');
    let url: URL; try { url = new URL(callbackUrl); } catch { throw new HttpError(400, '请粘贴浏览器地址栏的完整回跳地址'); }
    const expected = new URL(this.state.verificationUrl);
    if (url.origin !== 'http://localhost:1455' || url.pathname !== '/auth/callback' || !url.searchParams.get('code') || url.searchParams.get('state') !== expected.searchParams.get('state')) throw new HttpError(400, '回跳地址不属于本次登录，请使用刚刚打开的授权页面');
    this.manualReply(url.toString()); this.manualReply = undefined;
    return { ok: true };
  }
  private async run(controller: AbortController) {
    const timeout = setTimeout(() => controller.abort('timeout'), this.timeoutMs); timeout.unref();
    let authenticated = false;
    try {
      const runtime = await this.runtime(); controller.signal.throwIfAborted();
      await runtime.login('openai-codex', 'oauth', {
        signal: controller.signal,
        prompt: async prompt => {
          if (prompt.type === 'select' && prompt.options.some(o => o.id === 'browser')) return 'browser';
          if (prompt.type === 'manual_code') return new Promise<string>((resolve, reject) => {
            const signals = [controller.signal, prompt.signal].filter((s): s is AbortSignal => !!s);
            const cleanup = () => { signals.forEach(s => s.removeEventListener('abort', abort)); this.manualReply = undefined; };
            const abort = () => { cleanup(); reject(new Error('Login cancelled')); };
            this.manualReply = value => { cleanup(); resolve(value); };
            signals.forEach(s => s.addEventListener('abort', abort, { once: true }));
            if (signals.some(s => s.aborted)) abort();
          });
          throw new Error('Unsupported authentication prompt');
        },
        notify: event => {
          if (controller.signal.aborted || event.type !== 'auth_url') return;
          const url = new URL(event.url);
          if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize' || !url.searchParams.get('state')) throw new Error('Unexpected authentication URL');
          this.state = { ...this.state, phase: 'waiting', verificationUrl: url.toString(), expiresAt: Date.now() + this.timeoutMs, message: '点击下方按钮，在 OpenAI 页面登录并确认授权。完成后会自动连接。' };
        },
      });
      authenticated = true; controller.signal.throwIfAborted();
      this.state = { id: this.state.id, phase: 'verifying', authenticated, message: '登录成功，正在测试 GPT-6…' };
      const model = runtime.getModel('openai-codex', 'gpt-6-astra');
      if (!model) throw new Error('Model unavailable');
      const result = await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'Reply with OK only.', timestamp: Date.now() }] }, { reasoning: 'low', maxTokens: 1024, transport: 'sse', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]) });
      if (['error', 'aborted'].includes(result.stopReason) || !result.content.some(c => c.type === 'text' && c.text.trim())) throw new Error('Model verification failed');
      controller.signal.throwIfAborted();
      await this.selectModel();
      this.state = { id: this.state.id, phase: 'success', authenticated, message: '已登录 ChatGPT，GPT-6 测试通过并设为当前模型。' };
    } catch {
      // Provider errors can include raw token responses. Never forward them.
      this.state = { id: this.state.id, phase: controller.signal.aborted ? 'cancelled' : 'error', authenticated,
        message: controller.signal.aborted ? (controller.signal.reason === 'timeout' ? '登录已超时，请重新登录。' : '已取消。') : authenticated ? 'ChatGPT 已登录，但 GPT-6 测试未通过。请检查账号模型权限或网络，也可从已有 pi 模型中选择。' : '登录未完成。请检查网络后重新发起浏览器授权。',
      };
    } finally { clearTimeout(timeout); this.manualReply = undefined; }
  }
}
