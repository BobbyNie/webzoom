import {APIError} from './api';
import type {Identity} from './types';
interface KeepaliveOptions {
 expiresAt:string;
 active:()=>boolean;
 renew:(signal:AbortSignal)=>Promise<Identity>;
 inspect?:(signal:AbortSignal)=>Promise<Identity>;
 onRenewed:(identity:Identity)=>void;
 onExpired:()=>void;
 onUnavailable:()=>void;
 onRecovered:()=>void;
}
// A connected meeting counts as activity even when its tab is hidden.
// Use sequential requests so refresh-token rotation cannot overlap in one page.
export function keepSessionAlive(options:KeepaliveOptions):()=>void {
 let expires=Date.parse(options.expiresAt),disposed=false;
 let timer:ReturnType<typeof setTimeout>,controller:AbortController|undefined;
 const schedule=()=>{timer=setTimeout(()=>void tick(),Math.min(30000,Math.max(1000,(expires-Date.now())/3)))};
 const expire=()=>{disposed=true;options.onExpired()};
 async function tick(){
  if(disposed)return;
  const elapsed=Date.now()>=expires;
  if(elapsed&&!options.inspect){expire();return}
  if(elapsed||(options.active()&&expires-Date.now()<=60000)){
   controller=new AbortController();const timeout=setTimeout(()=>controller?.abort(),15000);
   try{
    // Another tab may have updated the shared Cookie. Inspect without extending idle sessions.
    const identity=await (elapsed?options.inspect!:options.renew)(controller.signal);
    if(disposed)return;
    expires=Date.parse(identity.expiresAt);
    if(!Number.isFinite(expires)||expires<=Date.now()){expire();return}
    options.onRenewed(identity);options.onRecovered();
   }catch(error){
    if(disposed)return;
    if(elapsed||(error instanceof APIError&&error.status===401)){expire();return}
    options.onUnavailable();
   }finally{clearTimeout(timeout);controller=undefined}
  }
  if(!disposed)schedule();
 }
 schedule();
 return()=>{disposed=true;clearTimeout(timer);controller?.abort()};
}
