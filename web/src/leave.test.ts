import {afterEach,expect,test,vi} from 'vitest';
import {leaveMeeting} from './leave';
afterEach(()=>vi.useRealTimers());

test('successful leave finishes once without a fallback or leftover timer',async()=>{
 vi.useFakeTimers();
 const options={notify:vi.fn(async()=>{}),fallback:vi.fn(),finish:vi.fn()};
 await leaveMeeting(options);
 expect(options.notify).toHaveBeenCalledTimes(1);
 expect(options.fallback).not.toHaveBeenCalled();expect(options.finish).toHaveBeenCalledTimes(1);
 expect(vi.getTimerCount()).toBe(0);
});

test('a stalled leave cannot trap the user on the meeting page',async()=>{
 vi.useFakeTimers();
 let signal:AbortSignal|undefined,resolve!:()=>void;
 const options={notify:vi.fn((value:AbortSignal)=>{signal=value;return new Promise<void>(done=>{resolve=done})}),fallback:vi.fn(),finish:vi.fn()};
 const pending=leaveMeeting(options);
 await vi.advanceTimersByTimeAsync(2000);
 expect(options.finish).toHaveBeenCalledTimes(1);
 expect(options.fallback).toHaveBeenCalledTimes(1);expect(signal?.aborted).toBe(true);
 await pending;resolve();await Promise.resolve();
 expect(options.finish).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
});

test('failed HTTP notification falls back once and cleans up its deadline',async()=>{
 vi.useFakeTimers();
 const options={notify:vi.fn(async()=>{throw new TypeError('offline')}),fallback:vi.fn(),finish:vi.fn()};
 await leaveMeeting(options);
 expect(options.fallback).toHaveBeenCalledTimes(1);expect(options.finish).toHaveBeenCalledTimes(1);
 expect(vi.getTimerCount()).toBe(0);
});

test('a failed socket fallback must not prevent leaving',async()=>{
 const options={notify:async()=>{throw new Error('offline')},fallback:()=>{throw new Error('socket closed')},finish:vi.fn()};
 await expect(leaveMeeting(options)).resolves.toBeUndefined();
 expect(options.finish).toHaveBeenCalledTimes(1);
});
