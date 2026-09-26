import { useMemo, useState } from 'react';
import { Box, ChevronDown, ChevronRight, Eye, EyeOff, Layers3, Search, X } from 'lucide-react';
import type { MeshInfo, Selection } from '../scene/renderer';

const labels: Record<string, string> = {
  frame: '中框与结构件', front: '屏幕与前面板', rear: '后盖', camera: '摄像模组',
  cameras: '摄像模组', battery: '电池', pcb: '电路板', mainboard: '主板',
  shields: '屏蔽罩', coil: '无线充电', connectors: '连接器', buttons: '按键',
  thermal: '散热组件', screws: '紧固件', display: '显示组件', flex: '柔性排线',
  electronics: '电路与电子元件',
};
export function ModelTree({meshes, selection, name, demo, select, visibility}: {
  meshes: MeshInfo[]; selection: Selection | null; name: string; demo: boolean;
  select: (id: string) => void; visibility: (ids: string[], visible: boolean) => void;
}) {
  const [query, setQuery] = useState(''), [expanded, setExpanded] = useState<Set<string>>(new Set()), [limits,setLimits] = useState<Record<string,number>>({});
  const groups = useMemo(() => {
    const found = new Map<string, MeshInfo[]>();
    for (const mesh of meshes) {
      const key = mesh.group || '模型部件';
      if (query && ![mesh.name,key,labels[key] || ''].join(' ').toLowerCase().includes(query.toLowerCase())) continue;
      const items = found.get(key) || []; items.push(mesh); found.set(key, items);
    }
    return [...found.entries()];
  },[meshes,query]);
  const grouped = groups.length > 1;
  return <><div className="tree-search"><Search size={14}/><input aria-label="搜索模型部件" placeholder="搜索部件或分组…" value={query} onChange={event=>setQuery(event.target.value)}/>{query && <button aria-label="清空搜索" onClick={()=>setQuery('')}><X size={12}/></button>}</div>
    <div className="tree-root"><ChevronDown size={13}/><Box size={15}/><strong title={name}>{name}</strong>{demo && <span className="tiny-tag">示例</span>}</div>
    {groups.map(([key,items]) => {
      const open = !grouped || !!query || expanded.has(key), visible = items.some(item=>item.visible), limit = limits[key] || 80;
      return <div className="model-group" key={key}>
        {grouped && <div className="model-group-heading"><button onClick={()=>setExpanded(old=>{ const next=new Set(old); next.has(key)?next.delete(key):next.add(key); return next; })} aria-expanded={open}>{open?<ChevronDown size={12}/>:<ChevronRight size={12}/>}<Layers3 size={14}/><span>{labels[key] || key}</span><small>{items.length}</small></button><button className="group-visibility" aria-label={`${visible?'隐藏':'显示'}分组 ${labels[key] || key}`} onClick={()=>visibility(items.map(item=>item.id),!visible)}>{visible?<Eye size={13}/>:<EyeOff size={13}/>}</button></div>}
        {open && items.slice(0,limit).map(mesh=><div className={`tree-row ${selection?.meshId===mesh.id?'selected':''} ${!mesh.visible?'is-hidden':''}`} key={mesh.id}><button className="tree-item" title={mesh.name} onClick={()=>select(mesh.id)}><span className="tree-line"/><Box size={13}/><span>{mesh.name.replace(/^AUREL_ONE_/, '').replaceAll('_',' ')}</span></button><button className="visibility" aria-label={`${mesh.visible?'隐藏':'显示'} ${mesh.name}`} onClick={()=>visibility([mesh.id],!mesh.visible)}>{mesh.visible?<Eye size={12}/>:<EyeOff size={12}/>}</button></div>)}
        {open && items.length>limit && <button className="tree-more" onClick={()=>setLimits(old=>({...old,[key]:limit+100}))}>再显示 {Math.min(100,items.length-limit)} 个部件</button>}
      </div>;
    })}
    {!groups.length && <div className="small-empty">{query?'没有匹配的部件':'模型载入后显示部件'}</div>}
  </>;
}
