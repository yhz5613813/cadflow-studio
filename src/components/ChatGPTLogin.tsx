import { useEffect, useRef, useState } from 'react';
import { ExternalLink, LoaderCircle, LogIn } from 'lucide-react';
import type { ChatGPTLogin as LoginState } from '../../shared/types';
import { api } from '../api';

export function ChatGPTLogin({ disabled, onActivity, onComplete }: { disabled: boolean; onActivity: (active: boolean) => void; onComplete: (selected: boolean) => Promise<void> }) {
  const [login, setLogin] = useState<LoginState>({ phase: 'idle' }), [error, setError] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const callbacks = useRef({ onActivity, onComplete }); callbacks.current = { onActivity, onComplete };
  const seen = useRef('');
  const active = ['starting', 'waiting', 'verifying'].includes(login.phase);
  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const state = await api.chatGPTLogin();
        if (disposed) return;
        setLogin(state); setError('');
        callbacks.current.onActivity(['starting', 'waiting', 'verifying'].includes(state.phase));
        if (state.authenticated && ['success', 'error', 'cancelled'].includes(state.phase) && seen.current !== state.id) {
          seen.current = state.id || ''; await callbacks.current.onComplete(state.phase === 'success');
        }
      } catch { if (!disposed) setError('暂时无法获取登录状态，正在重试…'); }
      finally { if (!disposed) timer = setTimeout(() => void poll(), 1500); }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); callbacks.current.onActivity(false); };
  }, []);
  return <section className="chatgpt-login" aria-label="ChatGPT 账号登录">
    <strong>使用 ChatGPT 账号</strong>
    <p>连接你的 ChatGPT / Codex 订阅，无需 API Key。</p>
    <button className="button primary full" disabled={disabled || active} onClick={async () => {
      callbacks.current.onActivity(true); setError('');
      try { setLogin(await api.startChatGPTLogin()); } catch (e) { setError((e as Error).message); callbacks.current.onActivity(false); }
    }}>{active ? <LoaderCircle size={16} className="spin"/> : <LogIn size={16}/>} {active ? '正在登录…' : login.authenticated ? '重新登录 ChatGPT' : '使用 ChatGPT 登录'}</button>
    {login.phase === 'waiting' && <div className="login-code-panel">
      <a className="button full" href={login.verificationUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={15}/>前往 OpenAI 授权</a>
      <p>登录 ChatGPT 并确认授权即可，无需输入设备验证码。完成后自动连接。</p>
      <details><summary>授权后浏览器无法返回？</summary>
        <p>如果浏览器停在 localhost:1455 的错误页面，将该页面地址栏的完整地址粘贴到这里。</p>
        <label className="field">授权回跳地址<input type="password" autoComplete="off" value={callbackUrl} onChange={e => setCallbackUrl(e.target.value)} placeholder="http://localhost:1455/auth/callback?…"/></label>
        <button className="button full" disabled={!callbackUrl.trim()} onClick={async () => { try { await api.submitChatGPTCallback(login.id!, callbackUrl); setCallbackUrl(''); setError(''); } catch(e) { setError((e as Error).message); } }}>完成连接</button>
      </details>
    </div>}
    {login.message && <p role="status" className={login.phase === 'error' ? 'form-error' : login.phase === 'success' ? 'positive' : 'hint'}>{login.message}</p>}
    {active && <button className="button full" onClick={async () => { try { setLogin(await api.cancelChatGPTLogin(login.id!)); callbacks.current.onActivity(false); } catch (e) { setError((e as Error).message); } }}>取消登录</button>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <p className="hint">登录由 pi 处理，凭据保存在本机。授权后将发送一条简短消息测试 GPT-6。</p>
  </section>;
}
