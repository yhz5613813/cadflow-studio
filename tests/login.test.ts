import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ChatGPTAuth } from '../server/login.js';

function fixture(options: { failLogin?: boolean; failModel?: boolean; timeoutMs?: number; manual?: boolean } = {}) {
  let authorize!: () => void; let selected = false; let loginCalls = 0;
  const runtime: Pick<ModelRuntime, 'login' | 'getModel' | 'completeSimple'> = {
    login: async (provider, type, interaction) => {
      loginCalls++; assert.equal(provider, 'openai-codex'); assert.equal(type, 'oauth');
      const choice = await interaction.prompt({ type: 'select', message: 'method', options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device' }] }); assert.equal(choice, 'browser');
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=fixture-state' });
      if (options.manual) await interaction.prompt({ type: 'manual_code', message: 'Fallback' });
      else await new Promise<void>((resolve, reject) => {
        authorize = resolve;
        interaction.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
      if (options.failLogin) throw new Error('provider error includes SECRET-TOKEN');
      return { type: 'oauth', access: 'SECRET-TOKEN', refresh: 'SECRET-REFRESH', expires: Date.now() + 3600000 };
    },
    getModel: () => ({ id: 'gpt-6-astra' }) as ReturnType<ModelRuntime['getModel']>,
    completeSimple: async (model, context, opts) => {
      assert.equal(model.id, 'gpt-6-astra'); assert.equal(opts?.reasoning, 'low'); assert.equal(context.messages.length, 1);
      return { stopReason: options.failModel ? 'error' : 'stop', content: [{ type: 'text', text: 'OK' }] } as Awaited<ReturnType<ModelRuntime['completeSimple']>>;
    },
  };
  const auth = new ChatGPTAuth(async () => runtime, async () => { selected = true; }, options.timeoutMs);
  const waiting = async () => { for (let i = 0; i < 100 && auth.status().phase !== 'waiting'; i++) await new Promise(r => setTimeout(r, 2)); assert.equal(auth.status().phase, 'waiting'); };
  const finished = async () => { for (let i = 0; i < 100 && auth.active; i++) await new Promise(r => setTimeout(r, 2)); assert.equal(auth.active, false); };
  return { auth, waiting, finished, authorize: () => authorize(), selected: () => selected, loginCalls: () => loginCalls };
}
test('ChatGPT browser login exposes auth URL, resumes same attempt, verifies GPT-6 before selecting', async () => {
  const f = fixture(); const started = f.auth.start(); await f.waiting();
  assert.equal(f.auth.start().id, started.id); assert.equal(f.loginCalls(), 1);
  assert.equal(f.auth.status().verificationUrl, 'https://auth.openai.com/oauth/authorize?state=fixture-state');
  assert.equal(f.auth.status().userCode, undefined); assert(!f.selected());
  f.authorize(); await f.finished();
  assert.equal(f.auth.status().phase, 'success'); assert(f.selected());
  assert(!JSON.stringify(f.auth.status()).includes('SECRET')); assert(!f.auth.status().userCode);
});
test('cancel stops OAuth, stale cancel cannot affect a newer login', async () => {
  const f = fixture(); const first = f.auth.start(); await f.waiting();
  await f.auth.cancel(first.id!); assert.equal(f.auth.status().phase, 'cancelled'); assert(!f.selected());
  const second = f.auth.start(); await f.waiting();
  assert.notEqual(first.id, second.id); await assert.rejects(f.auth.cancel(first.id!));
  assert(f.auth.active); await f.auth.cancel(second.id!);
});
test('login errors hide provider token payloads and keep old model selection', async () => {
  const f = fixture({ failLogin: true }); f.auth.start(); await f.waiting(); f.authorize(); await f.finished();
  assert.equal(f.auth.status().phase, 'error'); assert.equal(f.auth.status().authenticated, false);
  assert(!JSON.stringify(f.auth.status()).includes('SECRET')); assert(!f.selected());
});
test('successful auth with denied GPT-6 does not claim model connection or overwrite selection', async () => {
  const f = fixture({ failModel: true }); f.auth.start(); await f.waiting(); f.authorize(); await f.finished();
  assert.equal(f.auth.status().phase, 'error'); assert.equal(f.auth.status().authenticated, true); assert(!f.selected());
});
test('abandoned login expires and releases the login lock', async () => {
  const f = fixture({ timeoutMs: 25 }); f.auth.start(); await f.waiting(); await f.finished();
  assert.equal(f.auth.status().phase, 'cancelled'); assert.match(f.auth.status().message!, /超时/); assert(!f.selected());
});
test('manual browser callback rejects wrong state and origin, accepts only the current callback', async () => {
  const f = fixture({ manual: true }); const attempt = f.auth.start(); await f.waiting();
  assert.throws(() => f.auth.submitCallback(attempt.id!, 'http://localhost:1455/auth/callback?state=wrong&code=secret'));
  assert.throws(() => f.auth.submitCallback(attempt.id!, 'https://evil.example/auth/callback?state=fixture-state&code=secret'));
  assert.throws(() => f.auth.submitCallback('old-attempt', 'http://localhost:1455/auth/callback?state=fixture-state&code=secret'));
  f.auth.submitCallback(attempt.id!, 'http://localhost:1455/auth/callback?state=fixture-state&code=secret');
  await f.finished(); assert(f.selected()); assert(!JSON.stringify(f.auth.status()).includes('secret'));
});
test('cancel interrupts a pending manual callback', async () => {
  const f = fixture({ manual: true }); const attempt = f.auth.start(); await f.waiting();
  await f.auth.cancel(attempt.id!); assert.equal(f.auth.status().phase, 'cancelled'); assert(!f.selected());
});
