import {checkLocal} from './diagnostic-client.js';
import {origin} from './policy.js';
import {disconnectCode} from './messages.js';
const allowed=new Set(['start','configure','probe','chunk','ack','stop']);
chrome.runtime.onConnect.addListener(port=>{
 const sender=port.sender;let page;try{page=new URL(sender?.url??'')}catch{port.disconnect();return}
 if(!origin||port.name!=='webzoom-lan-v1'||sender.id!==chrome.runtime.id||sender.frameId!==0||page.origin!==origin||!page.pathname.startsWith('/m/')){port.disconnect();return}
 let native;let closed=false;const stop=()=>{if(closed)return;closed=true;try{native?.disconnect()}catch{};try{port.disconnect()}catch{}};
 try{native=chrome.runtime.connectNative('com.webzoom.lan')}catch{port.postMessage({type:'error',code:'native_stopped'});stop();return}
 native.onMessage.addListener(m=>{if(!closed)try{port.postMessage(m)}catch{stop()}});
 native.onDisconnect.addListener(()=>{const code=disconnectCode(chrome.runtime.lastError);if(!closed){try{port.postMessage({type:'error',code})}catch{};stop()}});
 port.onMessage.addListener(m=>{if(closed)return;if(!m||!allowed.has(m.type)||JSON.stringify(m).length>65536||(m.type==='start'&&m.origin!==origin)){stop();return};try{native.postMessage(m)}catch{stop()}});
 port.onDisconnect.addListener(stop);port.postMessage({type:'connected'});
});

// Installation checks never start a LAN session or send a broadcast. Only the
// provisioned website's top frame can ask; coalesce concurrent checks per tab.
const checks=new Map();
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 if(message?.type!=='webzoom-lan-diagnose-v1')return;
 let page;try{page=new URL(sender?.url??'')}catch{return}
 if(!origin||sender.id!==chrome.runtime.id||sender.frameId!==0||page.origin!==origin||(page.pathname!=='/'&&!page.pathname.startsWith('/m/')))return;
 const key=sender.tab?.id??'unknown';
 let task=checks.get(key);
 if(!task){task=checkLocal(chrome.runtime,origin);checks.set(key,task);task.finally(()=>{if(checks.get(key)===task)checks.delete(key)})}
 task.then(result=>respond({type:'diagnostic',...result,protocol:1,broadcastVerified:false}));
 return true;
});
