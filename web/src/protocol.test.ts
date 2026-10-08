import { describe, it, expect } from 'vitest';
import { pack, unpack, FrameGate } from './protocol';
import { Adaptation, profiles } from './quality';

describe('video protocol', () => {
 it('matches network byte order and rejects malformed packets', () => {
  const b = pack({epoch:7,sequence:9,timestamp:123456789,key:true,width:1920,height:1080,data:new Uint8Array([1,2,3])});
  expect([...new Uint8Array(b).slice(0,4)]).toEqual([87,90,48,49]);
  expect(unpack(b)).toMatchObject({epoch:7,sequence:9,timestamp:123456789,key:true,width:1920});
  expect(()=>unpack(b.slice(0,20))).toThrow();
  new DataView(b).setUint8(4,2);expect(()=>unpack(b)).toThrow();
 });
 it('requires a key after epoch changes and sequence gaps', () => {
  const g=new FrameGate();g.reset(2);
  const f={epoch:2,sequence:1,timestamp:1,key:false,width:1280,height:720,data:new Uint8Array([1])};
  expect(g.accept(f)).toBe(false);expect(g.accept({...f,key:true})).toBe(true);
  expect(g.accept({...f,sequence:3})).toBe(false);
  expect(g.accept({...f,sequence:4,key:true})).toBe(true);
  g.reset(3);expect(g.accept({...f,sequence:5,key:true})).toBe(false);
 });
});
describe('quality adaptation',()=>{
 it('reduces bitrate before resolution and recovers slowly',()=>{
  const a=new Adaptation();expect(a.level).toBe(0);
  a.congested(10000);expect(a.level).toBe(1);expect(profiles[a.level].height).toBe(1080);
  a.congested(10500);expect(a.level).toBe(1);
  a.congested(14000);expect(a.level).toBe(2);
  a.stable(20000);expect(a.level).toBe(2);
  a.stable(45000);expect(a.level).toBe(1);
 });
});

import { isStale } from './protocol';
it('rejects a frame more than one second behind the synchronized clock',()=>{
 expect(isStale(1_000_000,2001)).toBe(true);
 expect(isStale(1_000_000,1500)).toBe(false);
});
