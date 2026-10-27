import type {User} from './types';
export interface Point {x:number;y:number}
export type DrawingTool='pen'|'highlighter'|'temporary'|'line'|'arrow'|'rectangle'|'ellipse'|'text';
export interface AnnotationStyle {tool?:DrawingTool;width?:number;text?:string}
export interface HistoryCount {undo:number;redo:number}
export interface Stroke extends AnnotationStyle {expiresAt?:number;id:string;user:User;color:string;points:Point[];segment:number}
export interface Pointer {user:User;color:string;point:Point;updatedAt:number}
export interface AnnotationState {history?:Record<string,HistoryCount>;epoch:number;generation:number;strokes:Stroke[];pointers?:Record<string,Pointer>}
export interface AnnotationEvent extends AnnotationStyle {expiresAt?:number;history?:HistoryCount;kind:string;epoch:number;generation:number;user:User;strokeId?:string;segment?:number;color?:string;points?:Point[]}
export interface AnnotationCommand extends AnnotationStyle {kind:string;epoch:number;generation:number;strokeId?:string;segment?:number;color?:string;points?:Point[]}
export const annotationColors=['#e53935','#2563eb','#16a34a','#f59e0b','#7c3aed','#ec4899','#ffffff','#111827'];
export const emptyAnnotations=(epoch=0):AnnotationState=>({epoch,generation:0,strokes:[],pointers:{},history:{}});
export function videoRect(width:number,height:number,videoWidth:number,videoHeight:number){
 if(width<=0||height<=0||videoWidth<=0||videoHeight<=0)return {left:0,top:0,width:0,height:0};
 const scale=Math.min(width/videoWidth,height/videoHeight);
 const w=videoWidth*scale,h=videoHeight*scale;
 return {left:(width-w)/2,top:(height-h)/2,width:w,height:h};
}
export function normalizedPoint(x:number,y:number,rect:{left:number;top:number;width:number;height:number},videoWidth:number,videoHeight:number):Point|null {
 const visible=videoRect(rect.width,rect.height,videoWidth,videoHeight);
 if(!visible.width||!visible.height)return null;
 const nx=(x-rect.left-visible.left)/visible.width,ny=(y-rect.top-visible.top)/visible.height;
 if(nx<0||nx>1||ny<0||ny>1)return null;
 return {x:Math.round(nx*100000)/100000,y:Math.round(ny*100000)/100000};
}
export function applyAnnotation(state:AnnotationState,event:AnnotationEvent):AnnotationState {
 if(event.epoch!==state.epoch)return state;
 if(event.kind==='clear-own'||event.kind==='clear-all'){
  if(event.generation!==state.generation+1)return state;
  const history={...state.history};delete history[event.user.id];
  return {...state,history:event.kind==='clear-all'?{}:history,generation:event.generation,strokes:event.kind==='clear-all'?[]:state.strokes.filter(s=>s.user.id!==event.user.id),pointers:{}};
 }
 if(event.generation!==state.generation)return state;
 if(event.kind==='pointer'){
  const pointers={...state.pointers};
  if(event.points?.length)pointers[event.user.id]={user:event.user,color:event.color||annotationColors[0],point:event.points[0],updatedAt:Date.now()};
  else delete pointers[event.user.id];
  return {...state,pointers};
 }
 if(event.history)state={...state,history:{...state.history,[event.user.id]:event.history}};
 if(event.kind!=='draw'||!event.strokeId||event.segment===undefined||!event.points?.length)return state;
 const index=state.strokes.findIndex(s=>s.id===event.strokeId&&s.user.id===event.user.id);
 if(index<0){
  if(event.segment!==0)return state;
  return {...state,strokes:[...state.strokes,{id:event.strokeId,user:event.user,color:event.color||annotationColors[0],points:event.points,segment:0,tool:event.tool,width:event.width,text:event.text,expiresAt:event.expiresAt}]};
 }
 const stroke=state.strokes[index];
 if(event.segment!==stroke.segment+1)return state;
 const strokes=[...state.strokes];strokes[index]={...stroke,points:[...stroke.points,...event.points],segment:event.segment};
 return {...state,strokes};
}

export const visibleStrokes=(state:AnnotationState,now:number)=>state.strokes.filter(s=>!s.expiresAt||s.expiresAt>now);
export interface ViewTransform {scale:number;x:number;y:number}
export const initialView:ViewTransform={scale:1,x:0,y:0};
export function transformedVideoRect(boxWidth:number,boxHeight:number,width:number,height:number,view:ViewTransform){
 const r=videoRect(boxWidth,boxHeight,width,height);
 return {left:boxWidth/2+(r.left-boxWidth/2)*view.scale+view.x*boxWidth,top:boxHeight/2+(r.top-boxHeight/2)*view.scale+view.y*boxHeight,width:r.width*view.scale,height:r.height*view.scale};
}
export function pointInVideo(x:number,y:number,rect:{left:number;top:number;width:number;height:number}):Point|null {
 if(rect.width<=0||rect.height<=0)return null;
 const nx=(x-rect.left)/rect.width,ny=(y-rect.top)/rect.height;
 return nx<0||nx>1||ny<0||ny>1?null:{x:Math.round(nx*100000)/100000,y:Math.round(ny*100000)/100000};
}
export function clampView(view:ViewTransform,box:{width:number;height:number},width:number,height:number):ViewTransform {
 const scale=Math.min(3,Math.max(1,view.scale)),r=videoRect(box.width,box.height,width,height);
 const mx=box.width?Math.max(0,(r.width*scale-box.width)/(2*box.width)):0,my=box.height?Math.max(0,(r.height*scale-box.height)/(2*box.height)):0;
 return {scale,x:Math.max(-mx,Math.min(mx,view.x)),y:Math.max(-my,Math.min(my,view.y))};
}
// Hit testing uses screen pixels, so thin strokes remain usable on a touch screen.
export function strokeHit(s:Stroke,p:Point,width:number,height:number):boolean {
 const pts=s.points.map(q=>({x:q.x*width,y:q.y*height})),q={x:p.x*width,y:p.y*height},a=pts[0],b=pts.at(-1)!;
 if(!a)return false;
 const distance=(v:Point,w:Point)=>{const dx=w.x-v.x,dy=w.y-v.y,t=Math.max(0,Math.min(1,((q.x-v.x)*dx+(q.y-v.y)*dy)/(dx*dx+dy*dy||1)));return Math.hypot(q.x-v.x-t*dx,q.y-v.y-t*dy)};
 const radius=Math.max(12,(s.width??3)/2);
 if(s.tool==='text')return q.x>=a.x-8&&q.x<=a.x+Math.min(320,[...(s.text??'')].length*18)+8&&q.y>=a.y-24&&q.y<=a.y+8;
 if(s.tool==='rectangle')return [[a,{x:b.x,y:a.y}],[{x:b.x,y:a.y},b],[b,{x:a.x,y:b.y}],[{x:a.x,y:b.y},a]].some(([v,w])=>distance(v,w)<=radius);
 if(s.tool==='ellipse'){const rx=Math.abs(b.x-a.x)/2,ry=Math.abs(b.y-a.y)/2;if(!rx||!ry)return distance(a,b)<=radius;const d=Math.hypot((q.x-(a.x+b.x)/2)/rx,(q.y-(a.y+b.y)/2)/ry);return Math.abs(d-1)*Math.min(rx,ry)<=radius}
 if(pts.length===1)return distance(a,a)<=radius;
 return pts.slice(1).some((v,i)=>distance(pts[i],v)<=radius);
}
