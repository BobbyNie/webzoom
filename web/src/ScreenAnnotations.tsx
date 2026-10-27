import {useEffect,useRef,useState,type PointerEvent as ReactPointerEvent} from 'react';
import {createPortal} from 'react-dom';
import type {User} from './types';
import {annotationColors,pointInVideo,transformedVideoRect,clampView,visibleStrokes,strokeHit,initialView,type ViewTransform,type DrawingTool,type Stroke,type AnnotationState,type AnnotationCommand,type Point} from './annotations';
import StrokeGraphic from './StrokeGraphic';
import {exportAnnotatedFrame} from './annotationExport';
import './annotations.css';

type Tool='view'|'pointer'|'eraser'|DrawingTool;
type Props={toolbarHost:HTMLElement|null;state:AnnotationState;user:User;owner:boolean;allowed:boolean;active:boolean;width:number;height:number;errorVersion:number;send:(command:AnnotationCommand)=>void;view?:ViewTransform;pan?:boolean;onView?:(view:ViewTransform)=>void;onExitPan?:()=>void;exportEnabled?:boolean;canvas?:HTMLCanvasElement|null;clockOffset?:number};
type Draft={id:string;color:string;points:Point[];pending:Point[];segment:number;finished:boolean;finalSegment?:number;tool:DrawingTool;width:number;text?:string;createdAt:number};
const tools:{id:Tool;label:string;icon:string;hint:string}[]=[
 {id:'view',label:'观看',icon:'↖',hint:'退出绘画（Esc）'},{id:'pen',label:'画笔',icon:'✎',hint:'自由绘画（P）'},{id:'pointer',label:'指示光标',icon:'➤',hint:'带姓名的指示光标（L）'},
 {id:'highlighter',label:'荧光笔',icon:'▰',hint:'半透明强调'},{id:'temporary',label:'临时笔',icon:'◷',hint:'笔迹在 5 秒后消失'},
 {id:'line',label:'直线',icon:'╱',hint:'拖动画直线'},{id:'arrow',label:'箭头',icon:'↗',hint:'拖动画箭头'},{id:'rectangle',label:'矩形',icon:'□',hint:'拖动框选区域'},{id:'ellipse',label:'圆形',icon:'○',hint:'拖动画椭圆'},
 {id:'text',label:'文字',icon:'T',hint:'点击画面输入短文字'},{id:'eraser',label:'橡皮擦',icon:'⌫',hint:'点击擦除自己的一整笔（E），可以撤销'}
];
const freehand=(tool:Tool)=>tool==='pen'||tool==='highlighter'||tool==='temporary';
function preferences(){try{const p=JSON.parse(localStorage.getItem('webzoom.annotation.preferences.v1')??'{}');return {color:annotationColors.includes(p.color)?p.color:annotationColors[0],weight:[2,3,6,10].includes(p.weight)?p.weight:3,names:p.names!==false}}catch{return {color:annotationColors[0],weight:3,names:true}}}
export default function Annotations({toolbarHost,state,user,owner,allowed,active,width,height,errorVersion,send,view=initialView,pan=false,onView,onExitPan,exportEnabled=false,canvas,clockOffset=0}:Props){
 const [prefs]=useState(preferences),[tool,setTool]=useState<Tool>('view'),[color,setColor]=useState<string>(prefs.color),[weight,setWeight]=useState<number>(prefs.weight);
 const [collapsed,setCollapsed]=useState(true),[hidden,setHidden]=useState(false),[names,setNames]=useState(prefs.names),[panel,setPanel]=useState<'style'|'more'|null>(null);
 const [draft,setDraft]=useState<Draft|null>(null),[completed,setCompleted]=useState<Draft[]>([]),[box,setBox]=useState({width:0,height:0}),[now,setNow]=useState(Date.now()),[hint,setHint]=useState('');
 const [text,setText]=useState<{point:Point;value:string}|null>(null),[confirm,setConfirm]=useState<'clear-all'|'clear-own'|null>(null),[saving,setSaving]=useState(false);
 const area=useRef<HTMLDivElement>(null),surface=useRef<SVGSVGElement>(null),toolbar=useRef<HTMLDivElement>(null),clearTrigger=useRef<HTMLButtonElement|null>(null);
 const live=useRef({state,send,active,allowed,tool,color}),draftRef=useRef<Draft|null>(null),completedRef=useRef<Draft[]>([]),gesture=useRef<number|null>(null);
 const pointing=useRef<Point|null>(null),pointerDirty=useRef(false),lastPointer=useRef(0),panStart=useRef<{id:number;x:number;y:number;view:ViewTransform}|null>(null);
 live.current={state,send,active,allowed,tool,color};
 const seenAuthors=useRef(new Map<string,number>());
 for(const s of state.strokes){const key=`${s.user.id}:${s.id}`;if(!seenAuthors.current.has(key))seenAuthors.current.set(key,Date.now())}
 if(seenAuthors.current.size>256){const liveIDs=new Set(state.strokes.map(s=>`${s.user.id}:${s.id}`));for(const key of seenAuthors.current.keys())if(!liveIDs.has(key))seenAuthors.current.delete(key)}
 const canUse=active&&allowed&&width>0&&height>0;
 const visible=transformedVideoRect(box.width,box.height,width,height,view),strokes=visibleStrokes(state,now+clockOffset);
 const history=state.history?.[user.id]??{undo:0,redo:0},waiting=!!draft||completed.length>0;
 useEffect(()=>{try{localStorage.setItem('webzoom.annotation.preferences.v1',JSON.stringify({color,weight,names}))}catch{/* Storage can be disabled by company policy. */}},[color,weight,names]);
 useEffect(()=>{
  const node=area.current;if(!node)return;
  const measure=()=>setBox({width:node.clientWidth,height:node.clientHeight});measure();const observer=new ResizeObserver(measure);observer.observe(node);return()=>observer.disconnect();
 },[]);
 useEffect(()=>{
  draftRef.current=null;setDraft(null);completedRef.current=[];setCompleted([]);pointing.current=null;pointerDirty.current=false;gesture.current=null;panStart.current=null;setText(null);setConfirm(null);
  if(!active||!allowed){setTool('view');setPanel(null)}
 },[state.epoch,state.generation,active,allowed,errorVersion]);
 useEffect(()=>{setHidden(false);setHint('');setTool('view')},[state.epoch]);
 useEffect(()=>{
  const query=window.matchMedia('(max-width:760px)');let timer:ReturnType<typeof setTimeout>|undefined;
  // Ignore transient viewport changes (e.g. browser full-page capture or resize animation).
  const compact=()=>{clearTimeout(timer);if(query.matches)timer=setTimeout(()=>{if(query.matches){setCollapsed(true);setTool('view');setText(null)}},150)};
  query.addEventListener('change',compact);return()=>{clearTimeout(timer);query.removeEventListener('change',compact)};
 },[]);
 useEffect(()=>{
  pointing.current=null;pointerDirty.current=false;draftRef.current=null;setDraft(null);gesture.current=null;setText(null);
  if(live.current.active&&live.current.allowed)live.current.send({kind:'pointer',epoch:live.current.state.epoch,generation:live.current.state.generation,points:[]});
 },[tool,pan]);
 useEffect(()=>{
  const remaining=completedRef.current.filter(stroke=>stroke.pending.length>0||stroke.finalSegment===undefined||!state.strokes.some(s=>s.id===stroke.id&&s.user.id===user.id&&s.segment>=stroke.finalSegment!));
  if(remaining.length!==completedRef.current.length){completedRef.current=remaining;setCompleted([...remaining])}
 },[state.strokes,user.id,completed]);
 useEffect(()=>{
  const timer=setInterval(()=>{
   setNow(Date.now());const current=live.current;if(!current.active||!current.allowed)return;
   const stroke=completedRef.current.find(s=>s.pending.length>0)??draftRef.current;
   // Atomic shapes/text are sent only after release; freehand remains incremental.
   if(stroke?.pending.length&&(stroke.finished||freehand(stroke.tool))){
    const points=stroke.pending.splice(0,16),segment=stroke.segment++;
    if(stroke.finished&&!stroke.pending.length)stroke.finalSegment=segment;
    current.send({kind:'draw',epoch:current.state.epoch,generation:current.state.generation,strokeId:stroke.id,color:stroke.color,tool:stroke.tool,width:stroke.width,text:stroke.text,segment,points});
    if(stroke===draftRef.current)setDraft({...stroke,points:[...stroke.points]});else setCompleted([...completedRef.current]);
   }else if(pointerDirty.current||(current.tool==='pointer'&&pointing.current&&Date.now()-lastPointer.current>=700)){
    pointerDirty.current=false;lastPointer.current=Date.now();current.send({kind:'pointer',epoch:current.state.epoch,generation:current.state.generation,color:current.color,points:pointing.current?[pointing.current]:[]});
   }
  },100);return()=>clearInterval(timer);
 },[]);
 useEffect(()=>{const next=clampView(view,box,width,height);if(next.scale!==view.scale||next.x!==view.x||next.y!==view.y)onView?.(next)},[box.width,box.height,width,height,view.scale,view.x,view.y,onView]);
 const point=(event:ReactPointerEvent)=>{const rect=area.current?.getBoundingClientRect();return rect?pointInVideo(event.clientX-rect.left,event.clientY-rect.top,visible):null};
 const command=(kind:string,strokeId?:string)=>send({kind,strokeId,epoch:state.epoch,generation:state.generation});
 function select(next:Tool){setTool(next);setHidden(false);setHint('');if(pan)onExitPan?.()}
 function append(p:Point){
  const current=draftRef.current;if(!current||current.finished)return;
  if(!freehand(current.tool)){current.points=[current.points[0],p];current.pending=[...current.points];setDraft({...current});return}
  const previous=current.points.at(-1);if(previous&&Math.hypot(previous.x-p.x,previous.y-p.y)<.001)return;
  if(current.points.length>=500){current.finished=true;setHint('单笔长度达到上限，请抬起鼠标后继续绘制。');return}
  if(current.pending.length>=16){current.pending[current.pending.length-1]=p;current.points[current.points.length-1]=p}else{current.pending.push(p);current.points.push(p)}
  setDraft({...current,points:[...current.points]});
 }
 function queue(stroke:Draft){completedRef.current.push(stroke);setCompleted([...completedRef.current])}
 function down(event:ReactPointerEvent<SVGSVGElement>){
  if(!active||event.button!==0||gesture.current!==null)return;
  if(pan&&view.scale>1){event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);panStart.current={id:event.pointerId,x:event.clientX,y:event.clientY,view};gesture.current=event.pointerId;return}
  if(!canUse||hidden||collapsed||tool==='view')return;
  const p=point(event);if(!p)return;event.preventDefault();setHint('');
  if(tool==='pointer'){pointing.current=p;pointerDirty.current=true;return}
  if(tool==='eraser'){
   if(waiting){setHint('请等当前笔迹同步完成后再擦除。');return}
   const found=[...strokes].reverse().find(s=>s.user.id===user.id&&strokeHit(s,p,visible.width,visible.height));if(found)command('erase',found.id);else setHint('这里只能擦除你自己的笔迹。');return;
  }
  if(completedRef.current.length>=8){setHint('网络确认较慢，请稍候再绘制。');return}
  if(tool==='text'){setText({point:p,value:''});return}
  if(draftRef.current)return;
  event.currentTarget.setPointerCapture(event.pointerId);gesture.current=event.pointerId;
  const next:Draft={id:crypto.randomUUID(),color,points:[p],pending:[p],segment:0,finished:false,tool,width:weight,createdAt:Date.now()};draftRef.current=next;setDraft({...next});
 }
 function move(event:ReactPointerEvent<SVGSVGElement>){
  if(panStart.current?.id===event.pointerId){const start=panStart.current;onView?.(clampView({...start.view,x:start.view.x+(event.clientX-start.x)/Math.max(1,box.width),y:start.view.y+(event.clientY-start.y)/Math.max(1,box.height)},box,width,height));return}
  if(!canUse||hidden||collapsed||pan||tool==='view')return;
  const p=point(event);if(tool==='pointer'){pointing.current=p;pointerDirty.current=true}else if(p&&gesture.current===event.pointerId)append(p);
 }
 function finish(event:ReactPointerEvent<SVGSVGElement>){
  if(gesture.current!==event.pointerId)return;
  if(panStart.current){panStart.current=null;gesture.current=null}else{
   const p=point(event);if(p)append(p);const current=draftRef.current;
   if(current){if(!freehand(current.tool)&&current.points.length===1){current.points.push(current.points[0]);current.pending=[...current.points]}current.finished=true;current.finalSegment=current.pending.length?undefined:current.segment-1;queue(current);draftRef.current=null;setDraft(null)}gesture.current=null;
  }
  if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
 }
 function hide(){setHidden(v=>!v);setTool('view');setText(null)}
 function collapse(){setCollapsed(v=>!v);setPanel(null);setHint('');setTool('view');setText(null)}
 function clear(kind:'clear-own'|'clear-all'){draftRef.current=null;setDraft(null);completedRef.current=[];setCompleted([]);command(kind);setConfirm(null);clearTrigger.current?.focus()}
 const editEnabled=canUse&&!waiting;
 useEffect(()=>{
  const key=(event:KeyboardEvent)=>{
   if(event.defaultPrevented||event.isComposing||event.altKey||event.target instanceof Element&&event.target.closest('input,textarea,select,[contenteditable="true"],[role="dialog"],[role="alertdialog"]'))return;
   if(event.key==='Escape'){if(panel)toolbar.current?.querySelector<HTMLButtonElement>(`[aria-label="${panel==='style'?'笔迹设置':'更多批注操作'}"]`)?.focus();setTool('view');setText(null);setConfirm(null);setPanel(null);return}
   if(!live.current.active||!live.current.allowed)return;
   if(event.ctrlKey||event.metaKey){if(event.key.toLowerCase()==='z'||event.key.toLowerCase()==='y'){if(!editEnabled)return;event.preventDefault();const redo=event.shiftKey||event.key.toLowerCase()==='y';if(redo?history.redo:history.undo)command(redo?'redo':'undo')}return}
   const next=({p:'pen',l:'pointer',e:'eraser'} as Record<string,Tool>)[event.key.toLowerCase()];if(next){event.preventDefault();setCollapsed(false);select(next)}
  };window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
 },[editEnabled,history.undo,history.redo,state.epoch,state.generation,pan,view,panel]);
 const render=(s:Stroke)=><StrokeGraphic stroke={s} width={visible.width} height={visible.height}/>;
 const pendingGraphic=(s:Draft):Stroke=>({...s,user,segment:s.segment,expiresAt:s.tool==='temporary'?s.createdAt+5000:undefined});
 return <div className="annotation-layer" ref={area}>
  {active&&<>
   <svg ref={surface} className={`annotation-surface ${(canUse&&!hidden&&!collapsed&&tool!=='view')||pan?'interactive':''} ${tool} ${pan?'panning':''}`} aria-label="共享画面批注" data-testid="annotation-surface" viewBox="0 0 1000 1000" preserveAspectRatio="none" style={{left:visible.left,top:visible.top,width:visible.width,height:visible.height,visibility:undefined}}
    onPointerDown={down} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onContextMenu={event=>{event.preventDefault();setTool('view')}}
    onPointerLeave={()=>{if(tool==='pointer'){pointing.current=null;pointerDirty.current=true}}}>
    <g data-testid="annotation-strokes" visibility={hidden?'hidden':undefined}>{strokes.map(s=><g key={`${s.user.id}:${s.id}`} data-stroke-id={s.id} data-author={s.user.name}>{render(s)}<title>{s.user.name}</title></g>)}</g>
    <g data-testid="annotation-pending" visibility={hidden?'hidden':undefined}>{completed.filter(s=>s.tool!=='temporary'||s.createdAt+5000>now).map(s=><g key={s.id}>{render(pendingGraphic(s))}</g>)}{draft&&render(pendingGraphic(draft))}</g>
   </svg>
   {!hidden&&<>
    {Object.values(state.pointers??{}).filter(p=>now-p.updatedAt<1800).map(p=><span key={p.user.id} className="annotation-pointer" data-testid="annotation-pointer" style={{left:visible.left+p.point.x*visible.width,top:visible.top+p.point.y*visible.height,color:p.color}}><span className="pointer-symbol">➤</span>{names&&<span className="pointer-name">{p.user.name}</span>}</span>)}
    {names&&strokes.slice(-8).filter(s=>s.user.id!==user.id&&now-(seenAuthors.current.get(`${s.user.id}:${s.id}`)??0)<2500).map(s=><span className="annotation-author" key={`${s.user.id}:${s.id}`} style={{left:Math.max(0,Math.min(box.width-100,visible.left+s.points[0].x*visible.width)),top:Math.max(0,Math.min(box.height-20,visible.top+s.points[0].y*visible.height)),color:s.color==='#ffffff'?'#334155':s.color}}>{s.user.name}</span>)}
   </>}
   {toolbarHost&&createPortal(<div ref={toolbar} className={`annotation-toolbar ${collapsed?'collapsed':''}`} aria-label="屏幕批注工具">
    <div className="annotation-toolbar-row">
     <button type="button" className="annotation-toggle" aria-label={collapsed?'展开工具栏':'收起工具栏'} aria-expanded={!collapsed} title={collapsed?hidden?'展开批注工具（笔迹已隐藏，仅自己）':'展开批注工具':'收起批注工具，不删除笔迹'} onClick={collapse}><span aria-hidden="true">✎</span><span>批注</span><span aria-hidden="true">{collapsed?'⌃':'⌄'}</span></button>
     {!collapsed&&<>
      {allowed?<div className="annotation-tools" role="group" aria-label="批注工具选择">{tools.map(t=><button key={t.id} type="button" aria-label={t.label} title={`${t.label} · ${t.hint}`} aria-pressed={tool===t.id&&!pan} disabled={!canUse} onClick={()=>select(t.id)}><span aria-hidden="true">{t.icon}</span></button>)}</div>:<span className="annotation-readonly">仅观看 · 可在参与者面板申请权限</span>}
      <div className="annotation-utilities">
       {allowed&&<><button type="button" aria-label="笔迹设置" title="颜色与笔宽" aria-expanded={panel==='style'} onClick={()=>setPanel(p=>p==='style'?null:'style')}><span className="annotation-color-dot" style={{background:color}}/><span aria-hidden="true">⌄</span></button><button type="button" aria-label="撤销" disabled={!editEnabled||!history.undo} title="撤销自己的上一步（Ctrl/⌘+Z）" onClick={()=>command('undo')}>↶</button></>}
       <button type="button" aria-label={hidden?'显示批注':'隐藏批注'} aria-pressed={hidden} title={hidden?'显示笔迹（仅自己）':'隐藏笔迹（仅自己，不删除）'} onClick={hide}>{hidden?'◉':'⊘'}</button>
       <button type="button" aria-label="更多批注操作" title="重做、清除与显示设置" aria-expanded={panel==='more'} onClick={()=>setPanel(p=>p==='more'?null:'more')}>•••</button>
      </div>
     </>}
    </div>
    {!collapsed&&panel==='style'&&allowed&&<div className="annotation-options" role="group" aria-label="笔迹设置选项">
     <label>颜色<select aria-label="批注颜色" value={color} onChange={e=>setColor(e.target.value)}>{['红色','蓝色','绿色','黄色','紫色','粉色','白色','黑色'].map((label,i)=><option key={label} value={annotationColors[i]}>{label}</option>)}</select></label>
     <label>笔宽<select aria-label="批注笔宽" value={weight} onChange={e=>setWeight(Number(e.target.value))}>{[[2,'细'],[3,'标准'],[6,'粗'],[10,'特粗']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
     <span className="annotation-preview" aria-label="笔迹预览"><i style={{borderTop:`${weight}px solid ${color}`}}/></span>
    </div>}
    {!collapsed&&panel==='more'&&<div className="annotation-options" role="group" aria-label="更多批注选项">
     {allowed&&<><button type="button" disabled={!editEnabled||!history.redo} onClick={()=>command('redo')}>重做</button>
      <button type="button" disabled={!canUse} onClick={event=>{clearTrigger.current=event.currentTarget;setConfirm('clear-own')}}>清除我的</button>
      {owner&&<button type="button" className="annotation-danger" disabled={!canUse} onClick={event=>{clearTrigger.current=event.currentTarget;setConfirm('clear-all')}}>清除全部</button>}</>}
     <label><input type="checkbox" checked={names} onChange={e=>setNames(e.target.checked)}/>显示姓名</label>
     {exportEnabled&&<button type="button" disabled={!active||waiting||saving||!canvas} title="保存完整共享画面，不含尚未确认的笔迹" onClick={async()=>{if(!canvas)return;if(!window.confirm('截图可能包含公司业务内容。确认你有权保存到此电脑？'))return;setSaving(true);try{await exportAnnotatedFrame(canvas,surface.current,!hidden);setHint('截图已生成，请查看浏览器下载。')}catch(e){setHint((e as Error).message)}finally{setSaving(false)}}}>{saving?'保存中…':'保存截图'}</button>}
    </div>}
    {!collapsed&&(hidden||pan||waiting)&&<span className="annotation-live-status" role="status">{hidden?'批注已隐藏 · 仅自己':pan?'拖动画面 · 不绘画':completed.some(s=>now-s.createdAt>5000)?'同步较慢，请稍候':'正在同步笔迹…'}</span>}
    {hint&&<span className="annotation-dock-status annotation-hint" role="status">{hint}<button type="button" aria-label="关闭批注提示" onClick={()=>setHint('')}>×</button></span>}
   </div>,toolbarHost)}
   {text&&canUse&&<form className="annotation-text-editor" aria-label="输入文字批注" onSubmit={event=>{event.preventDefault();const value=text.value.trim();if(!value||[...value].length>160){setHint('请输入 1～160 个字。');return}if(completedRef.current.length>=8){setHint('请等待当前笔迹同步完成。');return}queue({id:crypto.randomUUID(),color,tool:'text',width:weight,text:value,points:[text.point],pending:[text.point],segment:0,finished:true,createdAt:Date.now()});setText(null)}}>
    <label>文字批注（最多 160 字）<input autoFocus aria-label="批注文字" value={text.value} maxLength={320} onChange={event=>setText({...text,value:event.target.value.replace(/[\r\n]/g,' ')})} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setText(null)}}}/></label><div><button type="submit">添加文字</button><button type="button" onClick={()=>setText(null)}>取消</button></div>
   </form>}
   {confirm&&<div className="annotation-confirm-backdrop"><section className="annotation-confirm" role="alertdialog" aria-modal="true" aria-labelledby="annotation-confirm-title" aria-describedby="annotation-confirm-desc" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setConfirm(null);clearTrigger.current?.focus()}if(event.key==='Tab'){const buttons=Array.from(event.currentTarget.querySelectorAll('button'));event.preventDefault();const index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(index+(event.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus()}}}>
    <h3 id="annotation-confirm-title">{confirm==='clear-all'?'清除所有人的批注？':'清除自己的全部批注？'}</h3><p id="annotation-confirm-desc">{confirm==='clear-all'?'所有参与者的画面都会更新。若只是不想看，请取消后使用“隐藏批注”。':'只删除你自己的笔迹，不删除其他人的内容。'}此操作不能撤销。</p>
    <div><button type="button" autoFocus onClick={()=>{setConfirm(null);clearTrigger.current?.focus()}}>取消</button><button type="button" className="annotation-danger" onClick={()=>clear(confirm)}>确认清除</button></div>
   </section></div>}
  </>}
 </div>;
}
