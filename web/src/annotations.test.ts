import {describe,it,expect} from 'vitest';
import {applyAnnotation,normalizedPoint,emptyAnnotations} from './annotations';

describe('shared-screen annotation geometry and authoritative updates',()=>{
 it('normalizes only the visible video, not letterboxing',()=>{
  const rect={left:10,top:20,width:1000,height:1000};
  expect(normalizedPoint(510,520,rect,1920,1080)).toEqual({x:.5,y:.5});
  expect(normalizedPoint(510,30,rect,1920,1080)).toBeNull();
 });
 it('applies authenticated draw events and fences old generations',()=>{
  const state=emptyAnnotations(2);
  const event={kind:'draw' as const,epoch:2,generation:0,user:{id:'u',name:'User'},strokeId:'s',segment:0,color:'#e53935',points:[{x:.1,y:.2}]};
  const drawn=applyAnnotation(state,event);
  expect(drawn.strokes).toHaveLength(1);
  expect(applyAnnotation(drawn,event)).toEqual(drawn);
  const cleared=applyAnnotation(drawn,{kind:'clear-all',epoch:2,generation:1,user:{id:'owner',name:'Owner'}});
  expect(cleared.strokes).toHaveLength(0);
  expect(applyAnnotation(cleared,event)).toEqual(cleared);
 });
 it('clears only the authenticated sender content',()=>{
  const state={...emptyAnnotations(2),strokes:[{id:'s',user:{id:'u',name:'User'},color:'#e53935',points:[{x:.1,y:.2}],segment:0},{id:'s2',user:{id:'v',name:'Other'},color:'#2563eb',points:[{x:.2,y:.3}],segment:0}]};
  const next=applyAnnotation(state,{kind:'clear-own',epoch:2,generation:1,user:{id:'u',name:'User'}});
  expect(next.strokes.map(s=>s.user.id)).toEqual(['v']);
 });
});

// New tools share exactly the same normalized coordinates as the video, even when panned.
import {transformedVideoRect,pointInVideo,clampView,visibleStrokes,strokeHit,type Stroke} from './annotations';
describe('annotation editing and viewing tools',()=>{
 const user={id:'u',name:'User'};
 const ink:Stroke={id:'ink',user,color:'#7c3aed',points:[{x:.2,y:.3},{x:.6,y:.7}],segment:0};
 it('round-trips normalized points through zoom, pan and letterboxing',()=>{
  for(const scale of [1,1.25,2,3])for(const box of [{width:1000,height:1000},{width:400,height:240}]){
   const view=clampView({scale,x:.2,y:-.1},box,1920,1080),rect=transformedVideoRect(box.width,box.height,1920,1080,view);
   expect(pointInVideo(rect.left+.35*rect.width,rect.top+.45*rect.height,rect)).toEqual({x:.35,y:.45});
   expect(pointInVideo(rect.left-1,rect.top,rect)).toBeNull();
  }
  expect(clampView({scale:7,x:9,y:9},{width:1000,height:1000},1920,1080)).toMatchObject({scale:3,x:expect.closeTo(1),y:.34375});
  expect(clampView({scale:1,x:1,y:-1},{width:1000,height:1000},1920,1080)).toMatchObject({scale:1,x:expect.closeTo(0),y:expect.closeTo(0)});
 });
 it('keeps style and actor-only history, including clear ownership',()=>{
  const drawn=applyAnnotation(emptyAnnotations(1),{kind:'draw',epoch:1,generation:0,user,strokeId:'ink',segment:0,color:ink.color,points:ink.points,tool:'arrow',width:6,history:{undo:1,redo:0}});
  expect(drawn.strokes[0]).toMatchObject({tool:'arrow',width:6});expect(drawn.history?.u).toEqual({undo:1,redo:0});
  const state={...drawn,history:{...drawn.history,v:{undo:2,redo:1}}};
  expect(applyAnnotation(state,{kind:'clear-own',epoch:1,generation:1,user}).history).toEqual({v:{undo:2,redo:1}});
  expect(applyAnnotation(state,{kind:'clear-all',epoch:1,generation:1,user}).history).toEqual({});
 });
 it('expires temporary ink without hiding permanent ink',()=>{
  const state={...emptyAnnotations(),strokes:[ink,{...ink,id:'temp',tool:'temporary' as const,expiresAt:2000}]};
  expect(visibleStrokes(state,1999)).toHaveLength(2);expect(visibleStrokes(state,2000).map(s=>s.id)).toEqual(['ink']);
 });
 it('hit-tests strokes, outlines and text, not an entire rectangle interior',()=>{
  expect(strokeHit(ink,{x:.4,y:.5},1000,1000)).toBe(true);expect(strokeHit(ink,{x:.9,y:.1},1000,1000)).toBe(false);
  expect(strokeHit({...ink,tool:'rectangle'},{x:.2,y:.5},1000,1000)).toBe(true);expect(strokeHit({...ink,tool:'rectangle'},{x:.4,y:.5},1000,1000)).toBe(false);
  expect(strokeHit({...ink,tool:'ellipse'},{x:.4,y:.3},1000,1000)).toBe(true);
  expect(strokeHit({...ink,tool:'text',text:'你好'},{x:.22,y:.29},1000,1000)).toBe(true);
 });
});
