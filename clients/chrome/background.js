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
