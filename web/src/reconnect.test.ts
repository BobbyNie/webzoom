import {afterEach,describe,it,expect,vi} from 'vitest';
import {reconnectDelay,withConnectionDeadline,watchSocketOpening} from './reconnect';
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


describe('bounded connection setup',()=>{
 afterEach(()=>vi.useRealTimers());
 it('aborts and rejects a lookup that ignores cancellation',async()=>{
  vi.useFakeTimers();let requestSignal!:AbortSignal;
  const pending=withConnectionDeadline(signal=>{requestSignal=signal;return new Promise(()=>{})},new AbortController().signal);
  const checked=expect(pending).rejects.toThrow('连接请求超时');
  await vi.advanceTimersByTimeAsync(10000);await checked;
  expect(requestSignal.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
 });
 it('cleans up a successful lookup without aborting it later',async()=>{
  vi.useFakeTimers();let requestSignal!:AbortSignal;
  expect(await withConnectionDeadline(signal=>{requestSignal=signal;return Promise.resolve(7)},new AbortController().signal)).toBe(7);
  await vi.advanceTimersByTimeAsync(10000);
  expect(requestSignal.aborted).toBe(false);expect(vi.getTimerCount()).toBe(0);
 });
 it('cancels an in-flight lookup on meeting cleanup',async()=>{
  vi.useFakeTimers();const lifetime=new AbortController();let requestSignal!:AbortSignal;
  const pending=withConnectionDeadline(signal=>{requestSignal=signal;return new Promise(()=>{})},lifetime.signal);
  const checked=expect(pending).rejects.toMatchObject({name:'AbortError'});
  lifetime.abort();await checked;
  expect(requestSignal.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
 });
 it('does not send a lookup after meeting cleanup',async()=>{
  vi.useFakeTimers();const lifetime=new AbortController();lifetime.abort();const request=vi.fn();
  await expect(withConnectionDeadline(request,lifetime.signal)).rejects.toMatchObject({name:'AbortError'});
  expect(request).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 });
 it('cleans up a synchronous lookup failure',async()=>{
  vi.useFakeTimers();
  await expect(withConnectionDeadline(()=>{throw new Error('network')},new AbortController().signal)).rejects.toThrow('network');
  expect(vi.getTimerCount()).toBe(0);
 });
 class Socket extends EventTarget {
  readonly CONNECTING=0;readyState=0;close=vi.fn(()=>{this.readyState=3});
 }
 it('retires an unfinished handshake exactly once even without a close event',async()=>{
  vi.useFakeTimers();const socket=new Socket(),expired=vi.fn();
  watchSocketOpening(socket as unknown as WebSocket,expired);
  await vi.advanceTimersByTimeAsync(10000);
  expect(socket.close).toHaveBeenCalledTimes(1);expect(expired).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(20000);expect(expired).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
 });
 it.each(['open','close'])('removes the handshake timer after %s',async event=>{
  vi.useFakeTimers();const socket=new Socket(),expired=vi.fn();
  watchSocketOpening(socket as unknown as WebSocket,expired);
  socket.readyState=event==='open'?1:3;socket.dispatchEvent(new Event(event));
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10000);
  expect(socket.close).not.toHaveBeenCalled();expect(expired).not.toHaveBeenCalled();
 });
 it('does not close an open socket whose open event is still queued',async()=>{
  vi.useFakeTimers();const socket=new Socket(),expired=vi.fn();
  watchSocketOpening(socket as unknown as WebSocket,expired);socket.readyState=1;
  await vi.advanceTimersByTimeAsync(10000);
  expect(socket.close).not.toHaveBeenCalled();expect(expired).not.toHaveBeenCalled();
 });
 it('removes the handshake timer on meeting cleanup',async()=>{
  vi.useFakeTimers();const socket=new Socket(),expired=vi.fn();
  const stop=watchSocketOpening(socket as unknown as WebSocket,expired);stop();stop();
  await vi.advanceTimersByTimeAsync(10000);
  expect(socket.close).not.toHaveBeenCalled();expect(expired).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 });
});
