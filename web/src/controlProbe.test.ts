import {afterEach,describe,expect,it,vi} from 'vitest';
import {ControlProbe} from './controlProbe';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()});
describe('fresh control connection check',()=>{
 it('requires the matching new reply and shares one pending probe',async()=>{
  vi.useFakeTimers();const send=vi.fn(),probe=new ControlProbe(send),result=probe.check();
  expect(probe.check()).toBe(result);probe.receive(123);probe.receive(-2);
  expect(send).toHaveBeenCalledTimes(1);probe.receive(-1);expect(await result).toBe(true);
  const next=probe.check();probe.receive(-1);probe.receive(-2);expect(await next).toBe(true);probe.dispose();expect(vi.getTimerCount()).toBe(0);
 });
 it('closes an unresponsive connection only after five seconds of running foreground timers',async()=>{
  vi.useFakeTimers();const probe=new ControlProbe(vi.fn()),result=probe.check();
  vi.advanceTimersByTime(5000);expect(await result).toBe(false);probe.dispose();
 });
 it('does not count hidden time as a foreground timeout',async()=>{
  vi.useFakeTimers();const send=vi.fn();let visible=false;const probe=new ControlProbe(send,()=>visible),result=probe.check(),done=vi.fn();void result.then(done);
  await vi.advanceTimersByTimeAsync(60000);expect(done).not.toHaveBeenCalled();
  // A queued old reply is not evidence that the server is still connected.
  probe.receive(-1);expect(send).toHaveBeenLastCalledWith(-2);visible=true;probe.receive(-2);expect(await result).toBe(true);probe.dispose();
 });
 it('restarts after an OS/event-loop suspension instead of reconnecting immediately',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1000);const send=vi.fn(),probe=new ControlProbe(send),result=probe.check();
  vi.setSystemTime(61000);await vi.advanceTimersByTimeAsync(250);expect(send).toHaveBeenLastCalledWith(-2);
  probe.receive(-1);probe.receive(-2);expect(await result).toBe(true);probe.dispose();
 });
 it('disposes a pending probe and never sends again',async()=>{
  vi.useFakeTimers();const send=vi.fn(),probe=new ControlProbe(send),result=probe.check();probe.dispose();
  expect(await result).toBe(false);expect(await probe.check()).toBe(false);expect(vi.getTimerCount()).toBe(0);expect(send).toHaveBeenCalledTimes(1);
 });
 it('requires a fresh challenge after visibility or page restoration and removes listeners',async()=>{
  vi.useFakeTimers();const doc=new EventTarget() as EventTarget&{visibilityState:string},win=new EventTarget();doc.visibilityState='hidden';
  vi.stubGlobal('document',doc);vi.stubGlobal('window',win);const send=vi.fn(),probe=new ControlProbe(send),result=probe.check();
  await vi.advanceTimersByTimeAsync(60000);doc.visibilityState='visible';doc.dispatchEvent(new Event('visibilitychange'));
  expect(send).toHaveBeenLastCalledWith(-2);probe.receive(-1);win.dispatchEvent(new Event('pageshow'));expect(send).toHaveBeenLastCalledWith(-3);
  probe.receive(-2);probe.receive(-3);expect(await result).toBe(true);probe.dispose();
  doc.dispatchEvent(new Event('visibilitychange'));win.dispatchEvent(new Event('pageshow'));expect(send).toHaveBeenCalledTimes(3);expect(vi.getTimerCount()).toBe(0);
 });
 it('fails closed and clears timers if sending the fresh challenge throws',async()=>{
  vi.useFakeTimers();const probe=new ControlProbe(()=>{throw Error('socket unavailable')});
  expect(await probe.check()).toBe(false);expect(vi.getTimerCount()).toBe(0);probe.dispose();
 });

});
