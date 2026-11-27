# 运行环境配置

以下命令从仓库根目录执行。工作台、参数化 CAD 和结构分析使用独立环境。Windows 建议给 Python 虚拟环境使用短路径。

## 1. 参数化 CAD

安装 Python 3.12，然后在 PowerShell 中执行：

~~~powershell
py -3.12 -m venv D:/castudio-env/cad
$cadPython = 'D:/castudio-env/cad/Scripts/python.exe'
& $cadPython -m pip install -r resources/parametric/requirements.txt
& $cadPython -m pip install -e 'resources/simplecadapi[editor]'
npm --prefix resources/simplecadapi/editor-web ci
npm --prefix resources/simplecadapi/editor-web run build
~~~

在应用数据目录创建 `parametric-runtime.json`。默认应用数据目录是仓库下的 `.studio`；若设置了 `STUDIO_DATA_DIR`，使用该目录。

~~~json
{
  "python": "D:/castudio-env/cad/Scripts/python.exe"
}
~~~

启动工作台，在参数化建模页面创建圆柱并打开编辑器。发布操作会确认草稿保存状态、冻结源码、导出 STEP 与场景包，并独立检查参考实体和三组仿真边界。

## 2. 结构分析与 Word 报告

~~~powershell
py -3.12 -m venv D:/castudio-env/structural
$solverPython = 'D:/castudio-env/structural/Scripts/python.exe'
& $solverPython -m pip install -e resources/structural-sim
& $solverPython -m structural_sim doctor
~~~

另外准备 CalculiX 可执行文件。圆柱案例此前使用 CalculiX 2.23；求解器不随此仓库分发。可从 [CalculiX 官方网站](https://www.calculix.de/) 获取对应平台版本。

在应用数据目录创建 `structural-runtime.json`：

~~~json
{
  "python": "D:/castudio-env/structural/Scripts/python.exe",
  "packageRoot": "D:/your-checkout/cadflow-studio/resources/structural-sim",
  "solver": "D:/your-tools/calculix/ccx_static.exe",
  "reportPython": "D:/castudio-env/structural/Scripts/python.exe",
  "workRoot": "D:/castudio-work/structural"
}
~~~

将示例中的仓库和求解器路径替换为本机绝对路径。报告解释器可以与求解解释器相同，依赖已包含 python-docx；也可以配置另一套已安装报告依赖的解释器。省略 workRoot 时，任务保存在应用数据目录的 structural-work 下。

每个分析保存源 STEP 快照、输入请求和独立结果目录。计算过程中可切换页面，返回后查看进度或取消。中断任务不会显示为完成；报告只使用实际接受的计算增量。

默认网格研究运行多个网格等级及载荷诊断，可能耗时较长。先完成线性分析，再运行几何非线性与网格研究。不同载荷完成度的结果不能直接当作收敛比较。

圆柱对象可在模型工作区直接编辑。`parametric-runtime.json` 中的 Python 同时负责对象参数校验、带名称的 STEP 装配预览和融合计算实体。无需打开 notebook 即可完成对象工作流。

如需在报告中加入当前模型的 Blender 渲染，在应用数据目录创建 `cylinder-runtime.json`：

~~~json
{
  "blender": "D:/your-tools/blender/blender.exe"
}
~~~

对象构建会用 Blender Cycles 渲染完整视图和剖切视图，并将图片与源 CAD 的哈希绑定。仿真启动时再次检查并冻结这些图片；没有配置 Blender 时仍可构建和分析，但变更后的报告不复用旧模型图片。Blender 展示图与实际求解云图分别生成。

## 3. 普通源码构建和热分析

普通「构建」使用界面配置的 Python，或 STUDIO_PYTHON。构建面板会分别检查解释器和 CAD 内核；参数化编辑器的配置不会自动替代普通构建解释器。

热分析仍使用单独的运行配置。参见 resources/thermal-sim 中的使用说明；本次圆柱交付不把结构回归视为热分析验收。

## 4. 回归验证

~~~powershell
npm test
npm run build
npm --prefix resources/simplecadapi/editor-web run build
& $solverPython -m pip install pytest
Push-Location resources/structural-sim
& $solverPython -m pytest tests -q
Pop-Location
& $cadPython resources/parametric/tests/test_objects_io.py
~~~

工作台模型服务测试使用本地协议夹具，不需要真实账号，也不表示已验证线上模型权限。Python 回归检查几何输入、语义边界、非线性帧和恢复逻辑；不替代完整 CalculiX 算例求解。

## 5. 本地数据

不要提交 .studio、虚拟环境、账号凭据、运行数据库或缓存。应用配置与科学输入分开保存；源码仓库包含圆柱模板、参考 STEP、报告展示图和测试，运行结果留在配置的数据目录。

## CAD 实体检查

在模型工作区的「工程工具 → 几何检查」中选择「CAD 实体检查」。它复用已配置的参数化 Python 环境，从 STEP/STP 原始几何计算属性；单位转换为毫米，密度以 kg/m³ 输入。密度可留空，填写后仅用于统一材料质量估算，不会修改结构分析材料。

可选择项目中的基准 STEP，或先在项目历史里载入参考版本，再比较。比较沿用模型坐标，不进行自动配准。有效材料并集通过检查后才提供体积和质量；多实体相交部分不重复计算。新增/减少材料通过双向实体差和体积平衡核验，可在模型视口打开或导出检查 JSON。源文件改动后历史记录会标记过期；冻结输入或差异文件被改写、缺失时，结果与预览会被停用并提示重新检查。

检查任务与输入快照保存在项目 `studio/cad-inspections/<run>/`，可取消，服务重启时未完成任务会标记中断。检查产物不替代默认设计预览或结构求解输入。现有「预览网格检查」保留，适用于三角网格拓扑检查。

开发验证（使用参数化建模 Python）：

```sh
python -m unittest discover -s resources/parametric/tests -p test_cad_inspect.py
```

可选的真实圆柱回归需要将 `CASTUDIO_CAD_TEST_CURRENT` 和 `CASTUDIO_CAD_TEST_BASELINE` 设置为改参后及基准 STEP 的绝对路径；未设置时只跳过该用例。曲面体积比较使用自适应积分，并重新导入导出的差异 STEP 核对体积，原布尔和体积平衡阈值保持不变。
