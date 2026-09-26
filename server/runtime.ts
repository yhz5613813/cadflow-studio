import path from 'node:path';
import os from 'node:os';
import type { RuntimeProbe } from '../shared/types.js';
import { HttpError, jsonRead, jsonWrite } from './storage.js';
import { runProcess } from './process.js';
const probeScript = `import sys,json,platform
r={"python":True,"version":platform.python_version(),"platform":platform.system()+"/"+platform.machine(),"cadflow":False}
try:
 import cadflow as cad
 r["cadflowVersion"]=str(getattr(cad,"__version__","unknown"))
 with cad.Model() as model:
  volume=model.box(2,3,4).volume
  if abs(volume-24.0)>1e-7: raise RuntimeError("CadFlow box volume smoke check failed")
 r["cadflow"]=True
 r["message"]="CadFlow 内核检查通过（2×3×4 方块体积为 24）"
except Exception as e:
 r["message"]="Python 可用，CadFlow 内核不可用："+type(e).__name__+": "+str(e)
print("STUDIO_RUNTIME="+json.dumps(r,ensure_ascii=True))
`;
export class Runtime {
  constructor(private root: string) {}
  async config(): Promise<{ executable: string }> { return jsonRead(path.join(this.root, 'runtime.json'), { executable: process.env.STUDIO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }); }
  async probe(value?: unknown): Promise<RuntimeProbe> {
    const executable = value === undefined ? (await this.config()).executable : value;
    if (typeof executable !== 'string' || executable.length > 2048 || /[\0\r\n]/.test(executable) || (!path.isAbsolute(executable) && !['python', 'python3'].includes(executable))) throw new HttpError(400, '填写 Python 可执行文件的绝对路径，或 python / python3；不要填写命令参数');
    let output = '';
    const base = { executable, python: false, cadflow: false, checkedAt: new Date().toISOString() };
    try {
      const result = await runProcess(executable, ['-I', '-X', 'utf8', '-u', '-c', probeScript], { cwd: os.tmpdir(), timeout: 20000, output: text => { output = (output + text).slice(-32000); } });
      if (result.timedOut) return { ...base, message: '运行环境检查超过 20 秒' };
      if (result.code !== 0) return { ...base, message: `解释器退出码 ${result.code}：${output.slice(-3000)}` };
      const line = output.split(/\r?\n/).reverse().find(line => line.startsWith('STUDIO_RUNTIME='));
      if (!line) return { ...base, message: '解释器没有返回有效检测结果' };
      const probe = JSON.parse(line.slice('STUDIO_RUNTIME='.length));
      if (probe.python !== true || typeof probe.cadflow !== 'boolean' || typeof probe.message !== 'string') throw new Error('无效检测结果');
      return { ...base, python: true, version: probe.version, platform: probe.platform, cadflow: probe.cadflow, cadflowVersion: probe.cadflowVersion, message: probe.message.slice(0, 4000) };
    } catch (error) { return { ...base, message: `无法启动解释器：${(error as Error).message}` }; }
  }
  async save(executable: unknown) { const probe = await this.probe(executable); if (!probe.python) throw new HttpError(422, probe.message); await jsonWrite(path.join(this.root, 'runtime.json'), { executable: probe.executable }); return probe; }
}
