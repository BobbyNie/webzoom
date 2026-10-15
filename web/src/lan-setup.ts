export type LocalCheck={ok:boolean;code:string};
// This separate bridge performs local diagnostics only: no session, no UDP send.
export function checkLANInstallation(expectedPort:number,timeout=6000):Promise<LocalCheck>{
 return new Promise(resolve=>{
  const channel=crypto.randomUUID();let done=false;
  const finish=(v:LocalCheck)=>{if(done)return;done=true;clearTimeout(timer);window.removeEventListener('message',message);resolve(v)};
  const message=(event:MessageEvent)=>{const v=event.data;if(event.source!==window||event.origin!==location.origin||v?.source!=='webzoom-lan-setup-extension-v1'||v.channel!==channel||v.message?.type!=='diagnostic')return;
   const m=v.message;if(m.ok===true&&m.port!==expectedPort){finish({ok:false,code:'port_mismatch'});return}finish({ok:m.protocol===1&&m.ok===true&&m.code==='local_ready'&&m.broadcastVerified===false,code:typeof m.code==='string'?m.code:'invalid_message'});
  };
  const timer=setTimeout(()=>finish({ok:false,code:'extension_missing'}),timeout);
  window.addEventListener('message',message);
  window.postMessage({source:'webzoom-lan-setup-page-v1',channel,message:{type:'diagnose'}},location.origin);
 });
}
