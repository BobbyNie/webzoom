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
