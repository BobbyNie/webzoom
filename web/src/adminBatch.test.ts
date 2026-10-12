import {it,expect,vi} from 'vitest';
import {endSelectedRooms} from './adminBatch';
it('ends only selected rooms in sequential bounded batches and records each result',async()=>{
 const ids=Array.from({length:205},(_,i)=>`room-${i}`);
 const send=vi.fn(async(roomIds:string[])=>({results:roomIds.map(id=>({id,status:id==='room-0'?'not_found':'ended'}))}));
 const result=await endSelectedRooms([...ids,ids[0]],send);
 expect(send.mock.calls.map(c=>c[0].length)).toEqual([100,100,5]);
 expect(send.mock.calls.flatMap(c=>c[0])).toEqual(ids);
 expect(result.ended).toEqual(ids.slice(1));expect(result.notFound).toEqual([ids[0]]);
 expect(result.unconfirmed).toEqual([]);
});
it('keeps confirmed results and stops later batches after a failed request',async()=>{
 const ids=Array.from({length:205},(_,i)=>`room-${i}`),error=new Error('timeout');
 const send=vi.fn(async(roomIds:string[])=>{if(roomIds[0]==='room-100')throw error;return {results:roomIds.map(id=>({id,status:'ended'}))}});
 const result=await endSelectedRooms(ids,send);
 expect(send).toHaveBeenCalledTimes(2);expect(result.ended).toEqual(ids.slice(0,100));
 expect(result.unconfirmed).toEqual(ids.slice(100));expect(result.error).toBe(error);
});
it.each([
 {results:[]}, {results:[{id:'other',status:'ended'}]},
 {results:[{id:'one',status:'unknown'}]}, {results:[{id:'one',status:'ended'},{id:'one',status:'ended'}]},
 null, {results:null},
])('never claims success for an incomplete or invalid response: %j',async(response)=>{
 const result=await endSelectedRooms(['one'],async()=>response as any);
 expect(result.ended).toEqual([]);expect(result.notFound).toEqual([]);
 expect(result.unconfirmed).toEqual(['one']);expect(result.error).toBeDefined();
});
