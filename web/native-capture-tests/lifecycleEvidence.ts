import type {Page} from '@playwright/test';
// Bounded, test-only lifecycle evidence. No replacement capture, frame reads,
// codec constructors, policy changes or extra media consumer.
interface LifecycleState {alerts:{at:number;text:string}[];stops:{at:number;kind:string;state:string;stack:string}[]}
declare global {interface Window {nativeLifecycle?:LifecycleState}}
export interface LifecycleProbe {page:Page;label:string;events:unknown[]}
export async function lifecycleProbe(page:Page,label:string):Promise<LifecycleProbe>{
 const events:unknown[]=[];
 const record=(event:unknown)=>{if(events.length<160)events.push({at:Date.now(),event})};
 page.on('console',message=>{if(message.type()==='error'||message.type()==='warning')record({kind:'console',type:message.type(),text:message.text().slice(0,1500)})});
 page.on('request',request=>{if(request.url().startsWith('https://127.0.0.1:20443/api/rooms/')&&request.url().endsWith('/actions')){let action='unknown';try{action=String(request.postDataJSON()?.action??'unknown')}catch{}record({kind:'action request',action})}});
 page.on('response',response=>{if(response.url().startsWith('https://127.0.0.1:20443/api/rooms/')&&response.url().endsWith('/actions'))record({kind:'action response',status:response.status()})});
 page.on('websocket',socket=>{socket.on('close',()=>record({kind:'websocket close'}));socket.on('socketerror',error=>record({kind:'websocket error',error:String(error)}))});
 await page.addInitScript(()=>{
  const evidence:LifecycleState=window.nativeLifecycle={alerts:[],stops:[]};
  const stop=MediaStreamTrack.prototype.stop;
  MediaStreamTrack.prototype.stop=function(...args:[]){if(evidence.stops.length<60)evidence.stops.push({at:Date.now(),kind:this.kind,state:this.readyState,stack:(new Error().stack??'').slice(0,1600)});return stop.apply(this,args)};
  const install=()=>{let last='';new MutationObserver(()=>{const text=document.querySelector('.banner.error')?.textContent??'';if(text&&text!==last&&evidence.alerts.length<30)evidence.alerts.push({at:Date.now(),text:text.slice(0,1600)});last=text}).observe(document.body,{subtree:true,childList:true,characterData:true})};
  if(document.body)install();else document.addEventListener('DOMContentLoaded',install,{once:true});
 });
 return {page,label,events};
}
export async function lifecycleSnapshot(probes:LifecycleProbe[]){return Promise.all(probes.map(async probe=>({label:probe.label,events:probe.events,state:probe.page.isClosed()?{closed:true}:await probe.page.evaluate(()=>window.nativeLifecycle).catch(error=>({error:String(error)}))})))}
