import type {User} from './types';
export interface Point {x:number;y:number}
export interface Stroke {id:string;user:User;color:string;points:Point[];segment:number}
export interface Pointer {user:User;color:string;point:Point;updatedAt:number}
export interface AnnotationState {epoch:number;generation:number;strokes:Stroke[];pointers?:Record<string,Pointer>}
export interface AnnotationEvent {kind:string;epoch:number;generation:number;user:User;strokeId?:string;segment?:number;color?:string;points?:Point[]}
export interface AnnotationCommand {kind:string;epoch:number;generation:number;strokeId?:string;segment?:number;color?:string;points?:Point[]}
export const annotationColors=['#e53935','#2563eb','#16a34a','#f59e0b'];
export const emptyAnnotations=(epoch=0):AnnotationState=>({epoch,generation:0,strokes:[],pointers:{}});
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
  return {...state,generation:event.generation,strokes:event.kind==='clear-all'?[]:state.strokes.filter(s=>s.user.id!==event.user.id),pointers:{}};
 }
 if(event.generation!==state.generation)return state;
 if(event.kind==='pointer'){
  const pointers={...state.pointers};
  if(event.points?.length)pointers[event.user.id]={user:event.user,color:event.color||annotationColors[0],point:event.points[0],updatedAt:Date.now()};
  else delete pointers[event.user.id];
  return {...state,pointers};
 }
 if(event.kind!=='draw'||!event.strokeId||event.segment===undefined||!event.points?.length)return state;
 const index=state.strokes.findIndex(s=>s.id===event.strokeId&&s.user.id===event.user.id);
 if(index<0){
  if(event.segment!==0)return state;
  return {...state,strokes:[...state.strokes,{id:event.strokeId,user:event.user,color:event.color||annotationColors[0],points:event.points,segment:0}]};
 }
 const stroke=state.strokes[index];
 if(event.segment!==stroke.segment+1)return state;
 const strokes=[...state.strokes];strokes[index]={...stroke,points:[...stroke.points,...event.points],segment:event.segment};
 return {...state,strokes};
}
