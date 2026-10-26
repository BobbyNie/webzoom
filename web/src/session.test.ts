import {afterEach,expect,test,vi} from 'vitest';
import {keepSessionAlive} from './session';
import {APIError} from './api';
import type {Identity} from './types';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()});
function setup(active=true){
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
 const identity:Identity={user:{id:'alice',name:'Alice'},csrf:'csrf',expiresAt:new Date(Date.now()+300000).toISOString()};
 const renewed={...identity,expiresAt:new Date(Date.now()+600000).toISOString()};
 const options={expiresAt:identity.expiresAt,active:vi.fn(()=>active),renew:vi.fn(async()=>renewed),onRenewed:vi.fn(),onExpired:vi.fn(),onUnavailable:vi.fn(),onRecovered:vi.fn()};
 return {options,renewed};
}
test('active meeting renews before five-minute expiry without pointer input',async()=>{
 const {options,renewed}=setup();const stop=keepSessionAlive(options);
 await vi.advanceTimersByTimeAsync(240000);
 expect(options.renew).toHaveBeenCalledTimes(1);expect(options.onRenewed).toHaveBeenCalledWith(renewed);
 await vi.advanceTimersByTimeAsync(61000);expect(options.onExpired).not.toHaveBeenCalled();expect(options.renew).toHaveBeenCalledTimes(1);stop();
});

test('idle home page sends no refresh and expires',async()=>{
 const {options}=setup(false);const stop=keepSessionAlive(options);
 await vi.advanceTimersByTimeAsync(301000);
 expect(options.renew).not.toHaveBeenCalled();expect(options.onExpired).toHaveBeenCalledTimes(1);stop();
});
test('short token lifetime renews before the first thirty-second interval',async()=>{
 const {options}=setup();options.expiresAt=new Date(Date.now()+6000).toISOString();
 const stop=keepSessionAlive(options);await vi.advanceTimersByTimeAsync(2000);
 expect(options.renew).toHaveBeenCalledTimes(1);stop();
});
test('temporary failure retries without expiring a still-valid session',async()=>{
 const {options}=setup();options.renew.mockRejectedValueOnce(new APIError(503,'unavailable'));
 const stop=keepSessionAlive(options);await vi.advanceTimersByTimeAsync(240000);
 expect(options.onUnavailable).toHaveBeenCalledTimes(1);expect(options.onExpired).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(20000);expect(options.renew).toHaveBeenCalledTimes(2);expect(options.onRecovered).toHaveBeenCalledTimes(1);stop();
});
test('provider rejection expires the login and stops further requests',async()=>{
 const {options}=setup();options.renew.mockRejectedValue(new APIError(401,'expired'));
 const stop=keepSessionAlive(options);await vi.advanceTimersByTimeAsync(600000);
 expect(options.onExpired).toHaveBeenCalledTimes(1);expect(options.renew).toHaveBeenCalledTimes(1);stop();
});
test('pending renewal does not overlap and cleanup ignores late results',async()=>{
 const {options,renewed}=setup();let resolve!:(identity:Identity)=>void;
 options.renew.mockImplementation(()=>new Promise<Identity>(r=>{resolve=r}));
 const stop=keepSessionAlive(options);await vi.advanceTimersByTimeAsync(270000);
 expect(options.renew).toHaveBeenCalledTimes(1);stop();resolve(renewed);await Promise.resolve();
 expect(options.onRenewed).not.toHaveBeenCalled();
});

test('idle tab observes renewal from another tab without refreshing tokens itself',async()=>{
 const {options,renewed}=setup(false);
 const inspect=vi.fn(async()=>renewed);
 const stop=keepSessionAlive({...options,inspect});
 await vi.advanceTimersByTimeAsync(301000);
 expect(inspect).toHaveBeenCalledTimes(1);expect(options.renew).not.toHaveBeenCalled();
 expect(options.onExpired).not.toHaveBeenCalled();expect(options.onRenewed).toHaveBeenCalledWith(renewed);stop();
});

test('transient inspection failure after local expiry retries instead of logging out',async()=>{
 const {options,renewed}=setup();
 const inspect=vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue(renewed);
 const stop=keepSessionAlive({...options,inspect});
 vi.setSystemTime(Date.now()+301000);await vi.advanceTimersByTimeAsync(32000);
 expect(inspect).toHaveBeenCalledTimes(2);expect(options.onUnavailable).toHaveBeenCalledTimes(1);
 expect(options.onExpired).not.toHaveBeenCalled();expect(options.onRenewed).toHaveBeenCalledWith(renewed);stop();
});
test('confirmed 401 after local expiry still terminates the session',async()=>{
 const {options}=setup();const inspect=vi.fn().mockRejectedValue(new APIError(401,'expired'));
 const stop=keepSessionAlive({...options,inspect});vi.setSystemTime(Date.now()+301000);await vi.advanceTimersByTimeAsync(30000);
 expect(options.onExpired).toHaveBeenCalledTimes(1);expect(inspect).toHaveBeenCalledTimes(1);stop();
});
test('page resume checks immediately and does not overlap requests or leak listeners',async()=>{
 const {options,renewed}=setup();const doc=new EventTarget(),win=new EventTarget();
 vi.stubGlobal('document',doc);vi.stubGlobal('window',win);
 let resolve!:(identity:Identity)=>void;const inspect=vi.fn(()=>new Promise<Identity>(r=>{resolve=r}));
 const stop=keepSessionAlive({...options,inspect});vi.setSystemTime(Date.now()+301000);
 doc.dispatchEvent(new Event('visibilitychange'));win.dispatchEvent(new Event('pageshow'));
 expect(inspect).toHaveBeenCalledTimes(1);resolve(renewed);await Promise.resolve();await Promise.resolve();
 expect(options.onRenewed).toHaveBeenCalledWith(renewed);stop();
 doc.dispatchEvent(new Event('visibilitychange'));win.dispatchEvent(new Event('pageshow'));
 expect(inspect).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);vi.unstubAllGlobals();
});
