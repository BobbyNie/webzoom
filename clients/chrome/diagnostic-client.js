import {disconnectCode} from './messages.js';
export function checkLocal(runtime, origin, timeoutMS=5000) {
 if (!origin) return Promise.resolve({code:'unconfigured',ok:false});
 return new Promise(resolve=>{
  let port,done=false;
  const finish=result=>{if(done)return;done=true;clearTimeout(timer);try{port?.disconnect()}catch{};resolve(result)};
  const timer=setTimeout(()=>finish({code:'diagnostic_timeout',ok:false}),timeoutMS);
  try {
   port=runtime.connectNative('com.webzoom.lan');
   port.onMessage.addListener(m=>{
    if(m?.type==='error') finish({code:m.code,ok:false});
    else if(m?.type==='diagnostic') {
     if(m.protocol!==1) finish({code:'version_mismatch',ok:false});
     else if(m.origin && m.origin!==origin) finish({code:'site_mismatch',ok:false});
     else if(m.code==='local_ready'&&(m.ok!==true||m.origin!==origin||m.broadcastVerified!==false)) finish({code:'invalid_message',ok:false});
     else finish({code:m.code,ok:m.ok===true&&m.code==='local_ready',port:m.port});
    }
   });
   port.onDisconnect.addListener(()=>{const code=disconnectCode(runtime.lastError);finish({code,ok:false})});
   port.postMessage({type:'diagnose',origin,protocol:1});
  }catch{finish({code:'native_stopped',ok:false})}
 });
}
