import {useEffect,useRef,useState,type PointerEvent as ReactPointerEvent} from 'react';
import type {User} from './types';
import {annotationColors,normalizedPoint,videoRect,type AnnotationState,type AnnotationCommand,type Point} from './annotations';
import './annotations.css';

type Props={state:AnnotationState;user:User;owner:boolean;allowed:boolean;active:boolean;width:number;height:number;errorVersion:number;send:(command:AnnotationCommand)=>void};
type Draft={id:string;color:string;points:Point[];pending:Point[];segment:number;finished:boolean;finalSegment?:number};
export default function Annotations({state,user,owner,allowed,active,width,height,errorVersion,send}:Props){
 const [tool,setTool]=useState<'view'|'pen'|'pointer'>('view'),[color,setColor]=useState(annotationColors[0]);
 const [draft,setDraft]=useState<Draft|null>(null),[box,setBox]=useState({width:0,height:0}),[now,setNow]=useState(Date.now()),[hint,setHint]=useState('');
 const area=useRef<HTMLDivElement>(null),live=useRef({state,send,active,allowed,tool,color}),draftRef=useRef<Draft|null>(null);
 const pointing=useRef<Point|null>(null),pointerDirty=useRef(false),lastPointer=useRef(0);
 live.current={state,send,active,allowed,tool,color};
 const canUse=active&&allowed&&width>0&&height>0;
 useEffect(()=>{
  const node=area.current;if(!node)return;
  const measure=()=>setBox({width:node.clientWidth,height:node.clientHeight});measure();
  const observer=new ResizeObserver(measure);observer.observe(node);return()=>observer.disconnect();
 },[]);
 useEffect(()=>{
  draftRef.current=null;setDraft(null);pointing.current=null;pointerDirty.current=false;
  if(!active||!allowed)setTool('view');
 },[state.epoch,state.generation,active,allowed,errorVersion]);
 useEffect(()=>{pointing.current=null;pointerDirty.current=true;draftRef.current=null;setDraft(null)},[tool]);
 useEffect(()=>{
  const current=draftRef.current;
  if(current?.finished&&current.finalSegment!==undefined&&state.strokes.some(s=>s.id===current.id&&s.user.id===user.id&&s.segment>=current.finalSegment!)){
   draftRef.current=null;setDraft(null);
  }
 },[state.strokes,user.id,draft?.finished,draft?.finalSegment]);
 useEffect(()=>{
  const timer=setInterval(()=>{
   setNow(Date.now());
   const current=live.current;if(!current.active||!current.allowed)return;
   const stroke=draftRef.current;
   if(stroke?.pending.length){
    const points=stroke.pending.splice(0,16),segment=stroke.segment++;
    if(stroke.finished&&!stroke.pending.length)stroke.finalSegment=segment;
    current.send({kind:'draw',epoch:current.state.epoch,generation:current.state.generation,strokeId:stroke.id,color:stroke.color,segment,points});
    setDraft({...stroke,points:[...stroke.points]});
   }else if(pointerDirty.current||(current.tool==='pointer'&&pointing.current&&Date.now()-lastPointer.current>=700)){
    pointerDirty.current=false;lastPointer.current=Date.now();
    current.send({kind:'pointer',epoch:current.state.epoch,generation:current.state.generation,color:current.color,points:pointing.current?[pointing.current]:[]});
   }
  },100);
  return()=>clearInterval(timer);
 },[]);
 const point=(event:ReactPointerEvent)=>{const rect=area.current?.getBoundingClientRect();return rect?normalizedPoint(event.clientX,event.clientY,rect,width,height):null};
 function append(p:Point){
  const current=draftRef.current;if(!current||current.finished)return;
  const previous=current.points.at(-1);
  if(previous&&Math.hypot(previous.x-p.x,previous.y-p.y)<.001)return;
  if(current.points.length>=500){current.finished=true;setHint('单笔长度达到上限，请抬起鼠标后继续绘制。');return}
  // Coalesce a burst without losing its latest position; no unbounded mouse queue.
  if(current.pending.length>=16){current.pending[current.pending.length-1]=p;current.points[current.points.length-1]=p}
  else {current.pending.push(p);current.points.push(p)}
  setDraft({...current,points:[...current.points]});
 }
 function down(event:ReactPointerEvent<SVGSVGElement>){
  if(!canUse||tool==='view'||event.button!==0)return;
  const p=point(event);if(!p)return;
  event.preventDefault();setHint('');
  if(tool==='pointer'){pointing.current=p;pointerDirty.current=true;return}
  if(draftRef.current)return;
  event.currentTarget.setPointerCapture(event.pointerId);
  const next:Draft={id:crypto.randomUUID(),color,points:[p],pending:[p],segment:0,finished:false};
  draftRef.current=next;setDraft({...next});
 }
 function move(event:ReactPointerEvent<SVGSVGElement>){
  if(!canUse||tool==='view')return;
  const p=point(event);
  if(tool==='pointer'){pointing.current=p;pointerDirty.current=true}
  else if(p)append(p);
 }
 function finish(event:ReactPointerEvent<SVGSVGElement>){
  if(tool!=='pen')return;
  const p=point(event);if(p)append(p);
  const current=draftRef.current;
  if(current){current.finished=true;current.finalSegment=current.pending.length?undefined:current.segment-1;setDraft({...current})}
  if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
 }
 const visible=videoRect(box.width,box.height,width,height);
 const strokes=state.strokes;
 const clear=(kind:string)=>{draftRef.current=null;setDraft(null);send({kind,epoch:state.epoch,generation:state.generation})};
 const path=(points:Point[])=>points.map(p=>`${p.x*1000},${p.y*1000}`).join(' ');
 function line(id:string,points:Point[],strokeColor:string){
  return points.length===1?<circle key={id} cx={points[0].x*1000} cy={points[0].y*1000} r="2" fill={strokeColor} vectorEffect="non-scaling-stroke"/>:
   <polyline key={id} points={path(points)} stroke={strokeColor} strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>;
 }
 return <div className="annotation-layer" ref={area}>
  {active&&<>
   <svg className={`annotation-surface ${canUse&&tool!=='view'?'interactive':''} ${tool}`} aria-label="共享画面批注" data-testid="annotation-surface" viewBox="0 0 1000 1000" preserveAspectRatio="none"
    style={{left:visible.left,top:visible.top,width:visible.width,height:visible.height}}
    onPointerDown={down} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onPointerLeave={()=>{if(tool==='pointer'){pointing.current=null;pointerDirty.current=true}}}>
    <g data-testid="annotation-strokes">{strokes.map(s=>line(`${s.user.id}:${s.id}`,s.points,s.color))}</g>
    {draft&&line('local-draft',draft.points,draft.color)}
   </svg>
   {Object.values(state.pointers??{}).filter(p=>now-p.updatedAt<1800).map(p=><span key={p.user.id} className="annotation-pointer" data-testid="annotation-pointer" style={{left:visible.left+p.point.x*visible.width,top:visible.top+p.point.y*visible.height,color:p.color}}><span className="pointer-symbol">➤</span><span className="pointer-name">{p.user.name}</span></span>)}
   <div className="annotation-toolbar" aria-label="屏幕批注工具">
    {allowed?<>
     <button type="button" aria-pressed={tool==='view'} onClick={()=>setTool('view')}>观看</button>
     <button type="button" aria-pressed={tool==='pen'} disabled={!canUse} onClick={()=>setTool('pen')}>画笔</button>
     <button type="button" aria-pressed={tool==='pointer'} disabled={!canUse} onClick={()=>setTool('pointer')}>指示光标</button>
     <select aria-label="批注颜色" value={color} onChange={e=>setColor(e.target.value)}><option value="#e53935">红色</option><option value="#2563eb">蓝色</option><option value="#16a34a">绿色</option><option value="#f59e0b">黄色</option></select>
     <button type="button" disabled={!canUse} onClick={()=>clear('clear-own')}>清除我的</button>
     {owner&&<button type="button" disabled={!canUse} onClick={()=>clear('clear-all')}>清除全部</button>}
    </>:<span>主持人可授予你批注权限</span>}
   </div>
   {hint&&<span className="annotation-hint" role="status">{hint}</span>}
  </>}
 </div>;
}
