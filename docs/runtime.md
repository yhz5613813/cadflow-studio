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

Blender 渲染图是已校验参考圆柱的展示资源，只有参数化 CAD 通过实体等价检查后才进入该路径的报告。它们不是求解云图。独立求解输入、位移与应力来自实际分析。

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
& $cadPython resources/parametric/tests/run_topology.py
~~~

工作台模型服务测试使用本地协议夹具，不需要真实账号，也不表示已验证线上模型权限。Python 回归检查几何输入、语义边界、非线性帧和恢复逻辑；不替代完整 CalculiX 算例求解。

## 5. 本地数据

不要提交 .studio、虚拟环境、账号凭据、运行数据库或缓存。应用配置与科学输入分开保存；源码仓库包含圆柱模板、参考 STEP、报告展示图和测试，运行结果留在配置的数据目录。
