import {afterEach,expect,test,vi} from 'vitest';
import {confirmSharingControl,sendSharingControl,withSharingDeadline} from './sharingControl';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()});

test('sharing reply clears its deadline and preserves the result',async()=>{
 vi.useFakeTimers();
 expect(await withSharingDeadline(async()=>({epoch:3}))).toEqual({epoch:3});
 expect(vi.getTimerCount()).toBe(0);
});
test('a stalled sharing request aborts and settles even if its fetch ignores abort',async()=>{
 vi.useFakeTimers();let signal:AbortSignal|undefined,finish!:(value:string)=>void;
 const pending=withSharingDeadline(value=>{signal=value;return new Promise<string>(resolve=>{finish=resolve})});
 const rejected=expect(pending).rejects.toThrow('超时');
 await vi.advanceTimersByTimeAsync(10000);await rejected;
 expect(signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
 finish('late');await Promise.resolve();
});
test('a rejected sharing request clears its timer without replacing the error',async()=>{
 vi.useFakeTimers();const error=new Error('network failure');
 await expect(withSharingDeadline(async()=>{throw error})).rejects.toBe(error);
 expect(vi.getTimerCount()).toBe(0);
});
test('stop requests can use the shorter two-second deadline',async()=>{
 vi.useFakeTimers();const rejected=expect(withSharingDeadline(()=>new Promise(()=>{}),2000)).rejects.toThrow('超时');
 await vi.advanceTimersByTimeAsync(2000);await rejected;expect(vi.getTimerCount()).toBe(0);
});
test('sharing cleanup carries its epoch and uses only the supplied open transport',()=>{
 vi.stubGlobal('WebSocket',{OPEN:1});const send=vi.fn();
 expect(sendSharingControl({readyState:1,send} as unknown as WebSocket,'cancel-start',7)).toBe(true);
 expect(send).toHaveBeenCalledWith(JSON.stringify({type:'cancel-start',epoch:7}));
 expect(sendSharingControl({readyState:3,send} as unknown as WebSocket,'stop-sharing',9)).toBe(false);
 expect(sendSharingControl(null,'stop-sharing',9)).toBe(false);expect(send).toHaveBeenCalledTimes(1);
});
test('a failed socket send is reported instead of becoming an unhandled error',()=>{
 vi.stubGlobal('WebSocket',{OPEN:1});
 expect(sendSharingControl({readyState:1,send:()=>{throw new Error('closed')}} as unknown as WebSocket,'cancel-start',1)).toBe(false);
});

function transport(){
 vi.stubGlobal('WebSocket',{OPEN:1});const target=new EventTarget();
 return Object.assign(target,{readyState:1,send:vi.fn(),close:vi.fn(),reply(value:unknown){target.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}))}});
}
test('cleanup waits for the matching server acknowledgement, ignoring unrelated messages',async()=>{
 vi.useFakeTimers();const socket=transport(),resolved=vi.fn();
 const pending=confirmSharingControl(socket as unknown as WebSocket,'cancel-start',4).then(resolved);
 socket.reply({type:'room'});socket.reply({type:'sharing-control',action:'cancel-start',epoch:3});
 socket.reply({type:'sharing-control',action:'stop-sharing',epoch:4});
 await Promise.resolve();expect(resolved).not.toHaveBeenCalled();
 socket.reply({type:'sharing-control',action:'cancel-start',epoch:4});await pending;
 expect(resolved).toHaveBeenCalledWith(true);expect(socket.close).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
test('unconfirmed cleanup retires only its owning transport after two seconds',async()=>{
 vi.useFakeTimers();const socket=transport();
 const pending=confirmSharingControl(socket as unknown as WebSocket,'cancel-start',4);
 await vi.advanceTimersByTimeAsync(2000);expect(await pending).toBe(false);
 expect(socket.close).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 socket.reply({type:'sharing-control',action:'cancel-start',epoch:4});expect(socket.close).toHaveBeenCalledTimes(1);
});
test('connection loss while awaiting cleanup settles and removes its deadline',async()=>{
 vi.useFakeTimers();const socket=transport();
 const pending=confirmSharingControl(socket as unknown as WebSocket,'stop-sharing',4);
 socket.dispatchEvent(new Event('close'));expect(await pending).toBe(false);expect(vi.getTimerCount()).toBe(0);
});
test('a missing cleanup transport never starts a deadline',async()=>{
 vi.useFakeTimers();vi.stubGlobal('WebSocket',{OPEN:1});
 expect(await confirmSharingControl(null,'cancel-start',0)).toBe(false);expect(vi.getTimerCount()).toBe(0);
});
