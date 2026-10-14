// Isolated world. The generated manifest matches one provisioned HTTPS origin only.
(()=>{if(window.top!==window)return;let port=null,channel='';const reply=message=>window.postMessage({source:'webzoom-lan-extension-v1',channel,message},location.origin);
 window.addEventListener('message',event=>{const v=event.data;if(event.source!==window||event.origin!==location.origin||v?.source!=='webzoom-lan-page-v1'||typeof v.channel!=='string'||v.channel.length>64||!location.pathname.startsWith('/m/'))return;
  if(v.message?.type==='connect'){port?.disconnect();channel=v.channel;const current=chrome.runtime.connect({name:'webzoom-lan-v1'});port=current;current.onMessage.addListener(m=>{if(port===current)reply(m)});current.onDisconnect.addListener(()=>{void chrome.runtime.lastError;if(port===current){port=null;reply({type:'error'})}});return}
  if(v.channel!==channel||!port||JSON.stringify(v.message).length>65536)return;
  if(v.message?.type==='stop'){port.postMessage({type:'stop'});port.disconnect();port=null;return}port.postMessage(v.message);
 });window.addEventListener('pagehide',()=>{port?.disconnect();port=null});})();
