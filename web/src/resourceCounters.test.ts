import {expect,it} from 'vitest';
import {validateCounters} from '../native-capture-tests/resourceCounters';
const row=(Id:number)=>({Id,WorkingSet64:1024,PrivateMemorySize64:2048,HandleCount:12});
it('accepts complete array and single-object PowerShell samples',()=>{
 expect(validateCounters([1,2],[row(2),row(1)]).complete).toBe(true);
 expect(validateCounters([1],row(1)).complete).toBe(true);
});
it('does not treat a missing or empty process sample as zero-memory success',()=>{
 expect(validateCounters([1,2],[row(1)])).toMatchObject({complete:false,missingIds:[2]});
 expect(validateCounters([1],[])).toMatchObject({complete:false,missingIds:[1]});
});
it('rejects duplicate or unrelated process IDs',()=>{
 expect(()=>validateCounters([1],[row(1),row(1)])).toThrow();
 expect(()=>validateCounters([1],[row(2)])).toThrow();
});
it('rejects missing, nonnumeric, negative, infinite and unsafe counters',()=>{
 for(const value of [undefined,'1024',-1,Infinity,Number.MAX_SAFE_INTEGER+1]){
  for(const key of ['WorkingSet64','PrivateMemorySize64','HandleCount'])expect(()=>validateCounters([1],[{...row(1),[key]:value}])).toThrow();
 }
 expect(()=>validateCounters([1],null)).toThrow();
});
it('rejects invalid or repeated browser-reported IDs before accepting OS data',()=>{
 for(const ids of [[],[0],[-1],[1,1],[NaN],[1.5]])expect(()=>validateCounters(ids,[])).toThrow();
});
