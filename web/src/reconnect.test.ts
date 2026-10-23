import {describe,it,expect} from 'vitest';
import {reconnectDelay} from './reconnect';
describe('bounded reconnect backoff',()=>{
 it('backs off with bounded jitter and stops after eight attempts',()=>{
  expect(Array.from({length:8},(_,i)=>reconnectDelay(i+1,()=>0.5))).toEqual([1000,2000,4000,8000,8000,8000,8000,8000]);
  for(let attempt=1;attempt<=8;attempt++){
   const base=Math.min(1000*2**(attempt-1),8000);
   expect(reconnectDelay(attempt,()=>0)).toBe(base*0.75);
   expect(reconnectDelay(attempt,()=>1)).toBe(base*1.25);
  }
  for(const attempt of [-1,0,1.5,9,Infinity,NaN])expect(reconnectDelay(attempt)).toBeNull();
 });
 it('clamps out-of-range randomness',()=>{
  expect(reconnectDelay(1,()=>-1)).toBe(750);
  expect(reconnectDelay(1,()=>2)).toBe(1250);
 });
});
