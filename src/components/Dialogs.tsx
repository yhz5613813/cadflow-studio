import { useState } from 'react';
import { Check, Download, ExternalLink, LoaderCircle, Package, PlugZap, Power, ShieldCheck, Trash2, X } from 'lucide-react';
import type { Plugin, Status } from '../../shared/types';
import { api } from '../api';
import { ChatGPTLogin } from './ChatGPTLogin';
export function Dialog({ title, subtitle, close, children }: { title: string; subtitle?: string; close: () => void; children: React.ReactNode }) {
  return <div className="modal-scrim" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><header><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" aria-label="关闭" onClick={close}><X size={20}/></button></header>{children}</section></div>;
}
export function PluginDialog({ plugins, refresh, close }: { plugins: Plugin[]; refresh: () => Promise<void>; close: () => void }) {
  const [source, setSource] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const act = async (key: string, action: () => Promise<unknown>) => { setBusy(key); setError(''); try { await action(); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); } };
  return <Dialog title="扩展" subtitle="添加建模工作流之外的扩展能力。" close={close}>
    <label className="field">GitHub 仓库<input value={source} onChange={e => setSource(e.target.value)} placeholder="https://github.com/owner/skill-repo"/></label>
    <button className="button primary full" disabled={!!busy} onClick={() => void act('install', () => api.install(source))}>{busy === 'install' ? <LoaderCircle size={16} className="spin"/> : <Download size={16}/>} {busy === 'install' ? '正在下载并检查 Skill…' : '安装扩展'}</button>
    <p className="hint"><ShieldCheck size={13}/>按提交版本安装 Skill 文件，不执行仓库安装脚本。支持 #分支 或 #提交。</p>
    <div className="section-heading">已安装 <span>{plugins.length}</span></div>
    {plugins.length === 0 ? <div className="small-empty">暂无额外扩展</div> : plugins.map(plugin => <div className="installed-plugin" key={plugin.id}><Package size={20}/><div className="grow"><strong>{plugin.name}</strong><p>{plugin.skills.length} 个 Skill · {plugin.revision.slice(0, 8)}</p><span className={plugin.enabled ? 'positive' : 'muted'}>{plugin.enabled ? '已启用 · 新会话可用' : '已停用'}</span></div><button title={plugin.enabled ? '停用插件' : '启用插件'} className={`icon-button ${plugin.enabled ? 'selected' : ''}`} disabled={!!busy} onClick={() => void act(plugin.id, () => api.enable(plugin.id, !plugin.enabled))}><Power size={16}/></button><button title="卸载插件" className="icon-button" disabled={!!busy} onClick={() => void act(plugin.id, () => api.remove(plugin.id))}><Trash2 size={16}/></button></div>)}
    {error && <p className="form-error" role="alert">{error}</p>}
  </Dialog>;
}
export function SettingsDialog({ status, refresh, close }: { status: Status | null; refresh: () => Promise<void>; close: () => void }) {
  const [selected, setSelected] = useState(status?.settings.model ? `${status.settings.provider}::${status.settings.model}` : ''), [thinking, setThinking] = useState(status?.settings.thinking || 'off');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1'), [model, setModel] = useState(''), [key, setKey] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [connected, setConnected] = useState(false);
  const [openAIKey, setOpenAIKey] = useState(''), [verified, setVerified] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const locked = busy || loggingIn;
  return <Dialog title="模型与运行环境" subtitle="pi 负责模型调用和工具执行，凭据只在本地服务端使用。" close={close}>
    <div className="runtime-card"><div className="pi-badge">π</div><div><strong>pi coding agent <span className="pill">{status?.pi || '0.85.1'}</span></strong><p>{status?.platform || '本地运行'} · 独立项目会话</p></div></div>
    <ChatGPTLogin disabled={busy} onActivity={setLoggingIn} onComplete={async selectedGPT6 => { if (selectedGPT6) { const current = await api.status(); setSelected(current.settings.provider + '::' + current.settings.model); setThinking(current.settings.thinking); } await refresh(); }}/>
    <details className="provider-details"><summary>GPT-6 Astra · OpenAI 官方 API</summary>
      <p className="hint">gpt-6-astra · Responses API · 支持工具调用。API 用量单独计费。</p>
      <label className="field">OpenAI API Key<input type="password" autoComplete="off" value={openAIKey} onChange={e => { setOpenAIKey(e.target.value); setVerified(false); }} placeholder="仅保存在本次服务进程内存中"/></label>
      <button className="button primary full" disabled={locked || !openAIKey.trim()} onClick={async () => { setBusy(true); setError(''); setVerified(false); try { await api.connectOpenAI(openAIKey); setOpenAIKey(''); setSelected('openai::gpt-6-astra'); setThinking('medium'); setVerified(true); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{busy ? <LoaderCircle className="spin" size={16}/> : <PlugZap size={16}/>}测试并连接 GPT-6</button>
      {verified && <p className="positive" role="status">GPT-6 已返回测试回复，已设为当前模型。</p>}
    </details>
    <label className="field">已有 pi 模型<select value={selected} onChange={e => { setSelected(e.target.value); if (e.target.value.endsWith('::gpt-6-astra') && ['off', 'minimal'].includes(thinking)) setThinking('medium'); }}><option value="">{status?.models.length ? '自动选择可用模型' : '未发现已登录的模型'}</option>{status?.models.map(m => <option key={`${m.provider}::${m.id}`} value={`${m.provider}::${m.id}`}>{m.provider} / {m.name}</option>)}</select></label>
    <label className="field">思考级别<select value={thinking} onChange={e => setThinking(e.target.value as typeof thinking)}>{(selected.endsWith('::gpt-6-astra') ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).map(t => <option key={t}>{t}</option>)}</select></label>
    <button className="button full" disabled={locked} onClick={async () => { setBusy(true); setError(''); try { const [provider = '', model = ''] = selected.split('::'); await api.settings({ provider, model, thinking }); await refresh(); close(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><Check size={16}/>保存模型设置</button>
    <details className="provider-details"><summary>连接 OpenAI 兼容服务</summary><label className="field">服务地址<input value={baseUrl} onChange={e => setBaseUrl(e.target.value)}/></label><label className="field">模型 ID<input value={model} onChange={e => setModel(e.target.value)} placeholder="填写服务商提供的模型名称"/></label><label className="field">API Key<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder="本次服务进程有效，不存入浏览器"/></label><button className="button primary full" disabled={locked || !model || !key} onClick={async () => { setBusy(true); setError(''); try { await api.connectProvider(baseUrl, model, key); setKey(''); setSelected(`studio::${model}`); setConnected(true); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{busy ? <LoaderCircle className="spin" size={16}/> : <PlugZap size={16}/>}连接模型</button>{connected && <p className="positive">已配置。现在可以向 Agent 发送消息。</p>}</details>
    <p className="hint">也可使用现有 pi 登录，或通过 .env 配置服务端凭据后重启。</p>
    {!status?.cadPlatformSupported && <div className="environment-note"><strong>CadFlow 运行环境</strong><p>当前 Windows 可运行界面和 pi。CadFlow 0.2.0 官方安装包需要 Linux x86_64 / Python 3.12，或 macOS arm64 / Python 3.13。建模代码可先编辑，实际几何计算需在支持的平台运行本应用。</p></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </Dialog>;
}
