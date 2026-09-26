# CadFlow Studio

本地 CAD 设计工作台，采用 React、Three.js 和 CodeMirror，具有 VS Code 风格的深色界面。CadFlow Skill 是随 Studio 一起发布的内置建模能力；Agent 运行核心使用 pi coding agent SDK 0.85.1。

## 启动

需要 Node.js 22.19+（推荐 Node 24）。进入应用目录：

```sh
npm ci
npm run build
npm start
```

打开 http://127.0.0.1:4317 。当前交付目录已安装依赖并完成构建，直接运行 `npm start` 即可。Windows 可使用 PowerShell 运行 `start.ps1`。开发模式为 `npm run dev`，同样使用 4317 端口。

CadFlow Skill 已包含在源码和分发包的 `resources/cadflow/` 中，不需要安装、启用或登录。Python/CadFlow 几何运行环境仍需按其指引准备。

## 使用

1. 点击「模型设置 → 使用 ChatGPT 登录」，打开 OpenAI 页面并确认授权；授权后自动测试并选择 GPT-6。也可使用官方 API Key 或已有 pi 模型。
2. 创建项目并导入模型，或直接描述建模需求。Agent 会读取内置 CadFlow 指引，编写 Python、执行工具并生成文件。
3. 在模型树中搜索部件、按原始装配分组显隐；使用视口工具查看剖切、网格面或并排参考模型。
4. 在底部面板编辑源码、下载产物、查看属性和工具记录。窄屏通过左侧「模型部件」按钮打开模型树。
5. 左侧「项目历史」可保存命名版本、比较文件差异、恢复旧成果，或展开历史模型并「设为对比参考」。
6. 打开正式场景包后，点击「场景与特征」查看装配层级、特征参数与依赖、包内源码位置，也可把特征信息加入对话草稿。
7. 选中部件或 STEP 面，点击「批注」保存检查意图。可定位原几何、编辑、标记处理状态、导出 JSON，或把待处理事项加入 Agent 草稿。
8. 点击「构建」配置已有 Python 解释器，检测 CadFlow 内核，再运行已保存源码；查看日志、下载成功产物，或另存到项目中。

## 源码构建与运行环境

「构建」面板支持 Python 可执行文件绝对路径（包括虚拟环境），默认使用 `STUDIO_PYTHON`，未设置则使用 `python` / `python3`。界面保存的解释器配置优先。检测分别报告 Python 可用性与 CadFlow 内核可用性，后者实际调用 `cadflow.Model().box(2,3,4)` 并检查体积 24；仅安装 Python 不会显示 CAD 内核已连接。本页不安装 Python、CadFlow、WSL 或系统功能。

执行前检查源码是否与已保存版本一致，并为项目建立快照。构建使用快照文件的独立副本，保存解释器、入口源码摘要、开始/结束时间、退出码、日志以及新增/变化产物的摘要。构建过程中可关闭面板，重新打开后继续查看和取消。停止时终止运行进程树；10 分钟超时自动终止，界面最多保留 512000 字符的日志末尾。

成功产物可逐项下载，也可另存到项目 `builds/<运行编号>/`，同时写入来源清单和项目历史。该操作不会覆盖原模型或原源码；完整目录写入后再进入项目。产物摘要变化、符号链接、过期源码、跨项目访问及并发写入会被拒绝。产物已经落盘但项目记录未更新完时，可点击「完成产物保存」重试收尾。脚本执行完成仅表示退出码为零，CAD 几何是否通过验证要查看脚本生成的真实检查报告。

构建记录位于 `.studio/projects/<项目编号>/builds/`，工作副本位于 `.studio/build-work/`，采用较短路径缓解 Windows 相对文件访问的长度限制。构建副本和历史一样只包含普通可见项目文件，不复制虚拟环境、隐藏文件和 `node_modules`；解释器依赖来自所选环境。工作目录仍受系统路径限制，复杂项目可用较短的 `STUDIO_DATA_DIR`。

构建目录不是操作系统沙箱：源码应使用相对项目路径并同步等待其子任务；硬编码绝对路径的脚本仍可能写到其他位置。正常关闭服务会取消活跃构建，异常退出后记录标为中断、禁止发布部分产物；强制结束服务时，操作系统可能保留子进程，需检查后重新运行。构建副本暂不自动清理。

## 几何批注与检查清单

批注保存在项目 `studio/annotations.json`，包含模型文件 SHA-256、预览版本、选择位置、操作意图、说明及处理状态。支持部件、STEP 来源面和显示三角面；场景包还记录节点与定义 ID。刷新后使用稳定选择标识重新定位，不依赖临时渲染 UUID。STEP 批注定位要求原导入器及预览精度；文件变化或精度不一致时保留旧批注并提示，避免指向其他几何。

「待处理批注加入草稿」和单条「加入草稿」提供有来源的 Agent 上下文，不自动发送。批注较多时引导 Agent 读取项目批注文件的全部待处理项。批注是用户意图，标为已解决也是人工状态，不代表几何验证已经通过。JSON 导出提供独立检查清单；目前不支持从导出 JSON 导入。

新增、编辑及删除前后自动保存项目历史，删除后可从历史恢复。修改使用版本校验和项目写入锁，拒绝过期覆盖；损坏的批注文件不会被空列表覆盖。每个项目最多 500 条、每条说明最多 4000 字符、文件最多 4 MB。示例模型不支持持久批注，需先导入项目模型。

## 场景包与源码关联

支持 CadFlow Scene 1.0 ZIP 和 SimpleCADAPI 产品包 3.0 `.scadpkg`。CadFlow 使用随应用发布的上游 TypeScript 合约校验器检查规范 ZIP、资源闭包、摘要、GLB、实体与嵌入源码引用；SimpleCADAPI 使用上游产品包读取器检查物理成员闭包与摘要、Scene 2.0 结构，并增加装配层级、刚体坐标系、特征依赖和源码行号校验。校验失败会给出错误，不降级为无关 GLB 的叠加预览。

加载按父子关系组合实例变换，将正式场景 GLB 的米制 Y-up 转换为毫米 Z-up。同一个几何资源可以供多个不同位置的实例共享。CadFlow 包内外观与初始显隐保留。普通 ZIP 只允许一个明确的 `model.glb` / `preview.glb`，或唯一 GLB；多个独立 GLB 没有装配清单时会拒绝猜测位置。

「场景与特征」可选择节点、搜索特征、查看参数和依赖、跳转到嵌入源码的对应行。源码快照只读，独立于当前项目源码编辑器。加入对话草稿会附带特征 ID、参数、源码行号和包 SHA-256，不会自动发送。选择上下文附带场景节点与定义 ID；这些 ID 不代替尚未接入的原生面/边/点选择。

本轮验证范围是预览与溯源，不执行包内源码，也不重新求解装配或重建 BREP。SimpleCADAPI 的复合产品/特征归档沿用上游 Viewer 的校验边界，尚未重建其内部产品语义闭包；目前使用合约夹具验证兼容性，完整 SDK 导出的复杂产品包还需补充验收。连接器/关节当前显示数量，尚未提供编辑与求解界面。上游版本、许可与适配说明位于 `resources/contracts/`。

## STEP 导入与面选择

STEP / STP 导入项目后可直接预览，不需要 Python、模型账号或外部转换服务。应用自带独立的 OCCT WebAssembly 导入器，在浏览器后台线程读取模型，保留装配分组、零件位置、颜色以及面对应的三角网格。STEP 长度统一转换为毫米，模型不套用 GLB 的坐标轴转换。

视口右上角可切换「快速 / 标准 / 精细」预览。加载时支持取消，取消后可重试；切换项目或文件会终止旧的解析任务。单次解析上限 2 分钟、文件 128 MB、结果 20000 个网格或 300 万个三角面。历史中的 STEP 也可以作为右侧参考模型。

选择工具栏的「选择面」，点击 STEP 零件会高亮整个来源面，而不是仅高亮一个显示三角面。属性面板显示面编号、所属三角面数量、毫米包围盒和文件摘要，也可输入面编号定位。面编号从 0 开始，只对当前文件及导入器有效；修改源文件后必须重新选择，不能直接把它当作 CadFlow 的原生面 ID。普通 GLB / STL 未提供面映射时仍按显示三角面选择。

面映射和文件 SHA-256 会随选择上下文传给设计助手。包围盒依据预览网格计算，曲面精度受预览设置影响；这里不声称进行了实体有效性检查、精确质量属性测量或特征历史恢复。STEP 预览不代表 Windows 已安装 CadFlow 的 Python 建模内核。

## 项目历史

手动保存源码、导入文件和 Agent 运行前后都会保存完整项目文件版本。源码保存会检查编辑起点，防止覆盖其他操作更新的文件。Agent 运行时，其他保存、导入和恢复操作会被拒绝，停止任务后可继续。

历史面板列出新增、修改、删除的文件，并显示文本前后内容及变化区段。二进制模型可下载，支持预览的历史模型可直接放到右侧参考视口；无需把旧文件覆盖到当前项目中。

恢复版本前必须先查看差异，服务端会检查项目是否在查看后发生变化。恢复会还原该版本中的源码和产物，并撤回之后新增的项目文件；当前成果先保存成「恢复前」版本，因此可以再次找回。对话记录保留，后续 Agent 会得到工作区已恢复的提示。每个历史文件都有 SHA-256 校验。恢复失败时回滚；进程在恢复中断时，下次启动会根据日志还原恢复前的文件。

历史保存在 `.studio/projects/<id>/history/`，相同内容只保存一份。范围为项目中的普通可见文件；隐藏目录/文件、`venv`、`node_modules`、`__pycache__` 不参与记录和恢复。当前限制为单文件 128 MB、项目内容 2 GB、10000 个文件；超限或符号链接会明确报错，不生成不完整快照。暂不自动清理历史；文本差异每个文件上限 200 KB，超限可下载原文件。外部程序不应在恢复时并发修改项目。文件与目录同名冲突会拒绝恢复，并保留当前成果。

内置 CadFlow 能力始终可供会话使用。扩展面板仅管理其他可选 Skill；修改扩展不会关闭或移除 CadFlow。旧版本单独安装的 CadFlow 插件记录会被忽略，项目和文件继续保留。

## 模型配置

GPT-6 官方 API：打开「模型设置 → GPT-6 Astra · OpenAI 官方 API」，输入 OpenAI API Key，点击「测试并连接 GPT-6」。服务端通过 pi 的原生 `openai-responses` 适配发送一条短测试消息；成功后选择 `openai / gpt-6-astra`，默认思考级别为 `medium`，可选 `low` 至 `max`。测试会产生少量 API 用量。无效密钥或不可用模型不会覆盖当前选择。界面密钥仅在服务进程内存中保存。

若要通过环境变量使用官方 GPT-6，可设置 `OPENAI_API_KEY`、`PI_PROVIDER=openai`、`PI_MODEL=gpt-6-astra` 后重启；已有界面模型选择优先于环境变量默认值。官方通道使用 pi 自带模型目录的配置，不需要填写兼容服务地址。

ChatGPT/Codex 订阅登录与官方 API Key 是不同通道。界面的「使用 ChatGPT 登录」调用 pi 原生浏览器 OAuth 流程：点击「前往 OpenAI 授权」，登录账号并确认授权，不需要设备验证码。pi 在本机 localhost:1455 接收回调；若回跳页面无法打开，可将该页面的完整地址填入「授权后浏览器无法返回？」中的密码框，服务端核对本次登录的 state 后完成连接。页面可取消登录，关闭设置后重新打开可恢复进度；15 分钟未完成自动超时。授权后发送一条短消息测试 `openai-codex / gpt-6-astra`，仅在模型回复成功后切换，默认思考级别为 `medium`。登录成功但 GPT-6 测试失败会单独提示，保留原模型选择。

pi 将登录凭据保存在 `~/.pi/agent/auth.json`（或 `PI_AGENT_DIR`），并负责自动刷新；浏览器只接收授权链接和公开进度，不接收登录令牌。Studio 不读取 Codex 应用的登录令牌。也可在 pi 终端执行 `/login`。订阅账号的模型权限以实际服务响应为准。

默认读取已有 pi 的 `~/.pi/agent/auth.json` 与 `models.json`。也可以复制 `.env.example` 为 `.env` 并填写：

```dotenv
STUDIO_MODEL_BASE_URL=https://your-provider.example/v1
STUDIO_MODEL_ID=your-model-id
STUDIO_MODEL_API_KEY=your-api-key
```

界面输入的 Key 仅在本次服务进程的内存中有效，重启后需要重新连接；环境变量配置可持久使用。兼容接口使用 Chat Completions、SSE 和 function tool calls，模型需要支持工具调用。模型名称需填写服务商实际提供的 ID。

额外扩展可在界面安装，也可运行 `npm run plugin:install -- owner/repo#ref`。这需要 Git。安装器只复制 Skill 资源，不执行仓库安装脚本。

## 项目和内置资源

```text
resources/cadflow/               # 随应用发布的内置能力与许可
  SKILL.md
  references/
  examples/
  LICENSE
  UPSTREAM.json
.studio/
  projects/<id>/workspace/       # 源码、模型与导入文件
  projects/<id>/sessions/        # pi 原生会话
  projects/<id>/messages.json    # 界面消息
  plugins/                      # 可选扩展
  settings.json                 # 模型选择
```

可通过 `STUDIO_DATA_DIR` 改变数据目录。内置能力从应用资源目录加载，不依赖某个用户的数据目录或插件开关。应用仍是独立项目，没有修改 CadFlow 内核仓库。

主要代码入口：

| 文件 | 作用 |
| --- | --- |
| `src/App.tsx` | 工作台与对话 |
| `src/components/ModelTree.tsx` | 搜索、分组及显隐 |
| `src/scene/renderer.ts` | 三维渲染和选择 |
| `src/theme.css` | 深色主题 |
| `public/cadflow-mark.svg` | 应用图标 |
| `server/builtin.ts` | 内置能力路径 |
| `server/harness.ts` | pi 会话和模型调用 |
| `server/plugins.ts` | 可选扩展管理 |
| `server/app.ts` | HTTP 和 SSE |

本地交付目录包含「AUREL ONE · 手机设计」项目，导入了原始手机 GLB、Python 源码和已有验证报告。GLB 约 22.8 MiB，显示 2622 个网格节点、651744 个三角面。隐藏「后盖」「无线充电」「屏蔽罩」可查看内部。本次未重新运行手机建模或 CAD 验证。项目数据不包含在源码 ZIP 中。

## 能力范围

### 网格检查与版本对比

选择部件、STEP 来源面或显示三角面后，打开底部「几何检查」。计算包围盒、表面积、边相连区域、边界边、非流形边/顶点、方向冲突、退化和重复三角面。满足边连接、顶点邻域和方向条件时提供**代数网格体积**；开放面或有缺陷时不提供体积。它不检查自相交、实体干涉和壳体包含关系，不能视为 CAD 内核认证，也不能把多壳体的代数体积直接当材料体积或质量。

计算在可取消的后台线程执行，超时 30 秒；每次最多 25 万个三角面。按完全相等的坐标合并接缝顶点，不通过舍入容差抹除细小间隙。使用载入时的装配变换，不受拆分、隐藏其他部件、相机或剖切展示影响；不支持蒙皮、活动形变和 GPU 实例网格。曲面结果受离散精度影响；普通 GLB 没有明确单位时显示「模型单位」。

「保存检查记录」将浏览器计算结果、模型路径/摘要、预览版本和选择范围写入 `studio/measurements.json`，最多 200 条，保存/删除前后保留历史。服务端核对模型文件摘要并拒绝过期列表或损坏文件；保存记录不代表服务器重新运行了 CAD 验证。可选任一历史测量作为人工对比基准，显示 X/Y/Z 尺寸、面积、可用代数体积的差值与百分比；只有两份记录均明确为毫米时才计算变化。用户应核对对比对象、选择范围和预览精度，不自动推断零件对应关系。

「导出检查报告」下载所选结果、基准、变化和方法限制，明确 `cadKernelVerified: false`；也可将检查结果加入对话草稿，让 Agent 进一步核对几何。当前仍未完成原生 CAD 质量属性、精确距离或工程图验收。

### 参数编辑与构建

打开底部「构建」，选择 Python 源码。若同目录存在对应的 `model.parameters.json`（入口为 `model.py`），页面会显示带单位、上下限的参数表。「保存参数」保留修改前后历史；「保存参数并构建」按保存的参数摘要提交构建，期间如果参数被其他操作修改会拒绝运行。关闭面板或切换源码前提示未保存的参数，刷新页面使用浏览器的未保存提示。

「新建参数化板件」在独立的 `models/plate-<编号>/` 目录创建源码和参数表，提供宽度、高度、厚度、中心孔径，包含最小孔壁约束。使用现有 CadFlow 0.2.0 API，执行成功后生成 STEP、STL 和几何检查报告（原生有效性、实体数、解析体积核对、STEP 回读体积）。需要已配置的受支持 CadFlow 解释器；缺少内核时如实失败，不生成替代几何。

参数协议 v1 示例：

```json
{
  "version": 1,
  "title": "安装板",
  "parameters": [
    { "name": "width", "label": "宽度", "type": "number", "unit": "mm", "value": 80, "min": 5, "max": 1000, "step": 1 },
    { "name": "hole", "label": "孔径", "type": "number", "unit": "mm", "value": 12, "min": 1, "max": 900, "step": 0.5 }
  ],
  "constraints": [
    { "terms": { "width": 1, "hole": -1 }, "min": 2, "message": "孔径应比宽度至少小 2 mm" }
  ]
}
```

支持 `number` / `integer`，单位为 `mm`、`cm`、`m`、`in`、`deg`、`unitless`。`step` 是输入增减步长，不要求值是步长的整数倍。关系约束对 `terms` 的加权和检查 `min` / `max`，引用参数必须使用同一种单位；不会执行表达式字符串，也不会自动换算单位。最多 100 个参数、100 条约束。UI 只改取值，完整定义由源码/Agent 维护。非法值、损坏定义、未知字段、过期保存均拒绝写入。

源码必须实际读取旁边的参数文件，例如 `json.loads(Path(__file__).with_suffix('.parameters.json').read_text(encoding='utf-8'))`，再从 `parameters` 列表读取 `name` / `value`，按声明单位传入内核。Studio 不能从文件命名推断任意脚本确实消费了参数。构建记录和另存产物清单会保留参数文件路径、SHA-256、各参数值及单位，原始文件也保存在该次构建快照中。参数值保存或普通 Python 执行成功不等于真实 CAD 几何验证通过。

GLB、内嵌资源的 glTF、STL、STEP/STP 和无外部材质依赖的 OBJ 可以预览。正式 ZIP/SCADPKG 按上述格式加载装配变换、特征和源码，不从预览网格重建 BREP 拓扑。

普通网格选择与包围盒基于显示网格；STEP 额外提供经导入器映射的来源面。三角面索引不是 CAD face ID，包围盒不是精确 CAD 测量。剖切是渲染裁剪，下载功能不会自动做格式转换。初次打开的法兰为交互示例。

当前 Windows 可以运行 Studio 和 pi。CadFlow 0.2.0 的官方 wheel 支持 Linux x86_64 / Python 3.12 和 macOS arm64 / Python 3.13。本版没有自动配置 WSL 或远程 CAD 执行器。

这是单用户本机应用。Agent 的终端工具以启动服务的系统用户权限执行，项目边界并非操作系统沙箱。只添加信任的扩展，不应直接部署为公共多用户服务。

## 验证

```sh
npm test
npm run build
```

测试使用真实 pi SDK 和本地 OpenAI 协议测试服务，检查流式消息、真实 write 工具落盘、会话恢复、取消、内置 CadFlow 持续加载、可选扩展启停、上传下载和文件边界。无需模型 Key，测试不会向外部模型发送请求。

构建测试需要真实 Python 3，默认 Windows 使用 `python`、其他系统使用 `python3`，可通过 `STUDIO_TEST_PYTHON` 指定解释器绝对路径。测试覆盖执行、进程树取消、产物保存恢复与 HTTP 流程；不要求已安装 CadFlow，也不将普通 Python 测试当作 CAD 内核验收。

历史测试还覆盖：二进制模型还原、源码差异、恢复前备份及再次恢复、重启恢复中断操作、损坏摘要、跨项目访问、过期比较、源码保存冲突，以及 Agent 运行期间的写入互斥。阶段计划与浏览器验收记录见 `ROADMAP.md`。

STEP 测试使用真实 OCCT WASM 与其公开 STEP 样例，验证毫米/米/英寸单位转换、六面立方体、18 个零件的装配位置、面映射、非法数据和拆分显示还原。浏览器另外验证了后台线程解析、取消/重试、精度切换和完整面高亮。

## 来源和许可

- [CadFlow Skill](https://github.com/zion-zion-zion/CadFlow-Skill)：内置资源，提交 `345687dc6cc0d195d123729e896e44908cd901b0`；MIT 许可证保留在资源目录。
- [pi](https://github.com/earendil-works/pi)：Agent SDK。
- [CadFlow](https://github.com/yhz5613813/CadFlow)：Skill 指导使用的 CAD 内核。
- [SimpleCADAPI](https://github.com/NiJingzhe/SimpleCADAPI)：交互布局参考。
- [occt-import-js 0.0.23](https://github.com/kovacsv/occt-import-js)：独立的 STEP 预览适配器。未修改的 JS/WASM 和许可证保存在 `public/vendor/occt/`；来源及替换说明见该目录 README。`npm run preview:prepare` 从锁定的 npm 依赖准备这些文件。

第三方资源保留各自许可证。源码包包含内置 CadFlow Skill，不包含用户项目、凭据、node_modules 或额外安装的扩展。


## Independent thermal simulation integration

The bottom dock now contains ???. The engine is the separately installed thermal-sim Python distribution, called through a versioned CLI/JSON adapter in server/thermal.ts. Configure STUDIO_THERMAL_PYTHON or save the Python interpreter in the Thermal panel. CadFlow and thermal interpreters may be different. The bundled resources/thermal-sim skill explains the standalone request protocol and CAD feedback workflow.

Build and publish a STEP/STL, select it in Thermal, save the material/boundary configuration, then run. Temperature fields, time curves, comparison, cancellation and report publication are available. Send results back to the design conversation with ?????????; this prepares a draft with the report, config and source hash. thermal-case.json is the editable case source. Saved simulations retain source geometry and hashes. Numeric thermal face IDs are independent of Studio preview IDs.

For real two-design acceptance, node --import tsx scripts/verify-thermal-loop.ts creates a new example project and performs two CadFlow builds and FEM solves with the configured interpreters. STUDIO_THERMAL_TEST_PYTHON enables the cancellation/recovery test.
