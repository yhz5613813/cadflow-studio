"""Automatic Word report from actual shell solver results. Run with document runtime."""
import json,sys,hashlib
from pathlib import Path
from datetime import datetime
from docx import Document
from docx.shared import Inches,Pt,RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

def create(root):
    root=Path(root);s=json.loads((root/'summary.json').read_text(encoding='utf-8-sig'));r=json.loads((root/'request.json').read_text(encoding='utf-8-sig'))
    d=Document();sec=d.sections[0];sec.page_width=Inches(8.5);sec.page_height=Inches(11)
    sec.top_margin=sec.bottom_margin=Inches(.65);sec.left_margin=sec.right_margin=Inches(.7)
    for name in ['Normal','Title','Heading 1','Heading 2']:
        st=d.styles[name];st.font.name='Microsoft YaHei';st._element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'),'Microsoft YaHei');st.font.color.rgb=RGBColor(0,0,0)
    d.styles['Normal'].font.size=Pt(10.5);d.styles['Normal'].paragraph_format.space_after=Pt(6)
    d.styles['Title'].font.size=Pt(23);d.styles['Heading 1'].font.size=Pt(16);d.styles['Heading 2'].font.size=Pt(12)
    for border in d.styles['Title']._element.xpath('.//w:pBdr'):border.getparent().remove(border)
    sec.header.paragraphs[0].text='CAStudio 结构仿真报告'
    footer=sec.footer.paragraphs[0];footer.alignment=2
    footer.add_run('第 ');f=OxmlElement('w:fldSimple');f.set(qn('w:instr'),'PAGE');footer._p.append(f);footer.add_run(' 页')
    def p(t):d.add_paragraph(t)
    def page_heading(text):
        heading=d.add_heading(text,1);heading.paragraph_format.page_break_before=True
        heading.paragraph_format.space_before=Pt(0)
        return heading
    def table(headers,rows,compact=False):
        t=d.add_table(rows=1,cols=len(headers));t.autofit=False
        for cell,value in zip(t.rows[0].cells,headers):cell.text=str(value)
        for row in rows:
            for cell,value in zip(t.add_row().cells,row):cell.text=str(value)
        for i,row in enumerate(t.rows):
            for cell in row.cells:
                tc=cell._tc.get_or_add_tcPr();b=OxmlElement('w:tcBorders')
                for edge in ['top','left','bottom','right']:
                    v=OxmlElement('w:'+edge);v.set(qn('w:val'),'single');v.set(qn('w:sz'),'4');v.set(qn('w:color'),'D9D9D9');b.append(v)
                tc.append(b);shade=OxmlElement('w:shd');shade.set(qn('w:fill'),'DCE7F0' if i==0 else ('F5F7F9' if i%2==0 else 'FFFFFF'));tc.append(shade)
                for pp in cell.paragraphs:
                    pp.paragraph_format.space_after=Pt(2 if compact else 4);pp.paragraph_format.space_before=Pt(2 if compact else 4)
                    pp.paragraph_format.line_spacing=1.05
                    snap=OxmlElement('w:snapToGrid');snap.set(qn('w:val'),'0');pp._p.get_or_add_pPr().append(snap)
                    for rr in pp.runs:rr.font.size=Pt(10);rr.bold=i==0
        return t
    d.add_paragraph('加筋铝合金圆柱结构非线性仿真' if s.get('mesh_study') else '加筋铝合金圆柱结构仿真',style='Title')
    p('轴向压缩与均布外压工况    '+datetime.now().strftime('%Y年%m月%d日'))
    d.add_heading('计算结论与适用范围',1)
    p(s.get('assessment','本报告记录已确认几何和假设弹性材料下的线性静力参考计算，以及理想结构特征值屈曲分析。应力和位移取自 CalculiX 实际输出，不代表已经验证的非线性极限承载能力。'))
    if s.get('load_factor',1)<.99999:
        p(f'当前云图实际对应轴压力 {r["axial_force_N"]*s["load_factor"]/9806.65:.3f} 公吨力、外压 {r["external_pressure_MPa"]*s["load_factor"]:.5f} MPa；不是目标全载荷结果。')
    table(['指标','实际计算结果'],[
        ['最大 von Mises 应力',f'{s["maximum_von_mises_MPa"]:.3f} MPa'],
        ['最大总位移',f'{s["maximum_displacement_mm"]:.4f} mm'],
        ['最大轴向缩短',f'{s["maximum_axial_shortening_mm"]:.4f} mm'],
        ['分析类型','几何非线性弹性' if s.get('mesh_study') else '线性弹性'],
        ['达到的载荷比例',f'{s.get("load_factor",1):.6g}'],
        ['力平衡相对残差' if s.get('assembled_balance_relative') is not None or not s.get('mesh_study') else '中面近似平衡残差',f'{s["balance_relative"]:.3e}'],
        ['材料模型','假设弹性；未启用塑性']],compact=True)
    d.add_heading('载荷与材料',1)
    table(['项目','数值或定义'],[
        ['目标轴向载荷',f'{r["axial_force_N"]:,.1f} N；{r["axial_force_N"]/9806.65:g} 公吨力'],['目标外压',f'{r["external_pressure_MPa"]:g} MPa；作用于筒皮外侧'],
        ['约束','下端框端面固定；壳模型约束下翻边中面全部平移与转动'],
        ['材料',f'用户确认的假设各向同性弹性铝材；E＝{r.get("E_MPa",70000)/1000:g} GPa，ν＝{r.get("nu",.33):g}'],
        ['连接','用户确认一体连接；筋条、蒙皮和端框共节点传力']],compact=True)
    page_heading('几何与有限元模型')
    table(['几何参数','已确认值'],[
        ['筒体','外径 1000 mm；总高 500 mm；蒙皮厚 2.5 mm'],['翻边','两端向内翻边；径向宽 50 mm；轴向厚 12 mm'],
        ['螺栓孔','每端 18 个 Ø15 mm 通孔；分布圆 Ø970 mm'],['纵筋','内侧 12 根；周向间隔 30°；宽 8 mm、高 12 mm'],
        ['环筋','内侧 5 道；宽 8 mm、高 12 mm；端框之间均布'],
        ['环筋中心 Z','91.333、170.667、250、329.333、408.667 mm']])
    p('CAD 是保留孔洞的单一实体。有限元采用 S8R 与 S6 二阶壳单元，筒皮中面半径为 498.75 mm，端框中面位于 Z＝6 和 494 mm，径向范围为 450～498.75 mm；壳理想化在筒皮中面处截断实体外缘的 1.25 mm 悬伸。筋条面延伸至这些中面交线，共享节点形成一体连接。该中面理想化包含交汇处的小范围延伸，未显式模拟焊缝、圆角或螺栓接触。')
    table(['离散与加载','核验结果'],[
        ['目标网格尺寸',f'{s["mesh_size_mm"]:g} mm'],['节点与单元',f'{s["nodes"]:,} 节点；{s["elements"]:,} 单元'],
        ['加载端中面净面积',f'{s["load"]["top_loaded_area_mm2"]:,.3f} mm²'],
        ['载荷施加','上翻边按初始净面积积分为等效节点轴向力，方向固定为全局负 Z；总轴向力保持不变。筒皮外压随当前法向作用。'],
        ['固定节点 RF 合力 N',', '.join(f'{v:.3f}' for v in s['reaction_N'])]])
    if s.get('assembled_balance_relative') is not None:
        p('力平衡采用求解器输出的全体节点 RF 合力检查，并交叉核对固定节点的两种输出。RF 包含节点上的外载及约束力。大变形时外压随当前法向作用，端部反力还包含外压产生的轴向分量；中面压力积分另作近似对照。')
    elif s.get('mesh_study'):
        p('本记录的平衡残差采用变形后筒皮中面的外压近似积分；壳厚度偏置后的实际加载面与中面有差异，因此该指标不是求解器实际节点合力的精确残差。')
    p('外压作用的筒皮中面为 Z＝6～494 mm；两端实体厚度区域以端框壳理想化，未另建其外缘厚度面。这是薄壳模型的端部近似，不能用于端框连接的三维局部应力评定。')
    p('孔圈与纵筋均以全局 +X 为起始角，每隔 60° 有一处螺栓孔与纵筋径向对齐。')
    if (root/'static/cad-full.png').exists() and (root/'static/cad-cutaway.png').exists():
        page_heading('CAD 结构渲染')
        p('以下采用已确认 STEP 实体的三角化几何，经 Blender Cycles 渲染。展示未变形结构与铝合金外观，颜色不表示应力或位移。')
        d.add_picture(str(root/'static/cad-full.png'),width=Inches(6.5))
        p('完整结构：外径 1000 mm，总高 500 mm；两端内翻边及螺栓孔保留。')
        d.add_picture(str(root/'static/cad-cutaway.png'),width=Inches(6.5))
        p('四分之一剖切展示：显露内部纵筋与五道环筋。暖色仅标识切面；剖切只用于展示，原 CAD 和计算模型保持完整。')
    page_heading('应力与变形云图')
    for index,(filename,caption) in enumerate([('mises.png','图 1  Mises 应力云图，单位 MPa。采用未变形构型，每个壳单元显示厚度方向原始积分点最大值。'),('displacement.png','图 2  总位移云图，单位 mm。几何按实际位移 1 倍显示；颜色表示位移模长。')]):
        if index:page_heading('总位移与变形')
        d.add_picture(str(root/'static'/filename),width=Inches(6.8));p(caption)
    page_heading('校核与结果解释')
    table(['部位','最大 Mises 应力 MPa'],[[{'bottom':'下端框','top':'上端框','skin':'筒皮','longitudinal':'纵筋','ring':'环筋'}.get(k,k),f'{v["maximum_von_mises_MPa"]:.3f}'] for k,v in s['components'].items()],compact=True)
    if (root/'static/top-detail.png').exists():
        d.add_picture(str(root/'static/top-detail.png'),width=Inches(6.0))
        d.paragraphs[-1].paragraph_format.space_before=Pt(8)
        p('上端框热点局部放大，采用未变形坐标显示实际积分点应力包络；颜色范围与整模型应力云图一致。空白孔区没有单元。')
    b=s.get('buckling',{})
    if b.get('factors'):
        p('特征值屈曲载荷路径：轴压力和外压按同一个系数同比放大或缩小。该系数只描述理想弹性结构的线性化分岔，不等于考虑缺陷、塑性和后屈曲后的允许载荷。')
        table(['阶次','载荷系数'],[[i+1,f'{v:.6g}'] for i,v in enumerate(b['factors'])],compact=True)
    if s.get('convergence'):
        page_heading('网格敏感性与数值核验')
        c=s['convergence'];table(['网格 mm','单元数','位移 mm','Mises MPa'],[[x['size_mm'],x['elements'],f'{x["u_mm"]:.4f}',f'{x["mises_MPa"]:.2f}'] for x in c['levels']]);p(c['interpretation'])
    if s.get('mesh_study'):
        page_heading('几何非线性与网格收敛验证')
        p('几何非线性采用 NLGEOM、大位移增量平衡和自动减小步长。材料仍为 E＝70 GPa、ν＝0.33 的假设弹性材料，未加入塑性。CalculiX 的该材料采用 Green 应变与第二类 Piola 应力之间的弹性关系；输出 S 为 Cauchy 应力。每档网格均计算线性参考场与非线性加载路径。')
        table(['网格 mm','类型','载荷比例','位移 mm','峰值 MPa','筒皮远场 MPa'],[[r['size_mm'],'非线性' if mode=='nonlinear' else '线性',f'{r[mode]["load_factor"]:.5f}',f'{r[mode]["maximum_displacement_mm"]:.3f}',f'{r[mode]["maximum_von_mises_MPa"]:.1f}',f'{r[mode]["bulk_skin_max_mises_MPa"]:.1f}'] for r in s['mesh_study']['levels'] for mode in ['linear','nonlinear']])
        p('收敛判据：相同载荷下，最后两级网格的最大位移、全局峰值应力和指定筒皮远场应力变化均小于 5%。不同载荷比例的终止结果不用于判定网格收敛。筒皮远场定义为单元中心满足 50＜Z＜450 mm，且距环筋和纵筋交线均大于 20 mm 的区域。')
        p('非线性网格判定：'+('达到上述指标。' if s['mesh_study']['converged'] else '尚未满足全部指标的 5% 标准，具体变化见下表。'))
        last=s['mesh_study']['comparisons'][-1]
        def delta(mode,key):
            value=last[mode].get(key+'_relative_change')
            return '载荷不同' if value is None else f'{100*value:.2f}%'
        table([f'{last["from_mm"]:g}→{last["to_mm"]:g} mm','位移变化','峰值变化','远场最大值变化'],[[label,delta(mode,'maximum_displacement_mm'),delta(mode,'maximum_von_mises_MPa'),delta(mode,'bulk_skin_max_mises_MPa')] for mode,label in [('linear','线性'),('nonlinear','非线性')]])
        d.add_picture(str(root/'study.png'),width=Inches(6.8))
        if s['mesh_study'].get('common_load_factor',1)<.99999:
            page_heading('相同载荷下的网格比较')
            p(f'以下采用三档网格都实际收敛并输出过的载荷比例 {s["mesh_study"]["common_load_factor"]:.6g}，未对不同终止载荷的结果直接作收敛判断，也未把插值值当作求解结果。')
            table(['网格 mm','最大位移 mm','峰值应力 MPa'],[[r['size_mm'],f'{r["maximum_displacement_mm"]:.4f}',f'{r["maximum_von_mises_MPa"]:.2f}'] for r in s['mesh_study']['common_load_levels']])
            a,b=s['mesh_study']['common_load_levels'][-2:]
            changes=[100*abs(a[k]-b[k])/abs(b[k]) for k in ['maximum_displacement_mm','maximum_von_mises_MPa']]
            p(f'该相同载荷下，最后两级网格的位移变化为 {changes[0]:.2f}%，峰值应力变化为 {changes[1]:.2f}%。这不等于目标全载荷下全部指标已经收敛。')
    if s.get('diagnosis'):
        page_heading('高应力来源分析')
        for text in s['diagnosis']['paragraphs']:p(text)
    d.save(root/'report.docx')
if __name__=='__main__':create(sys.argv[1])
