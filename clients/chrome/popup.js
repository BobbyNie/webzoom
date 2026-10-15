import {origin} from './policy.js';
import {messageFor} from './messages.js';
import {checkLocal} from './diagnostic-client.js';
const button=document.getElementById('check'),result=document.getElementById('result');
document.getElementById('site').textContent=origin ? '对应网站：'+origin : '尚未配置会议网站';
button.addEventListener('click',async()=>{
 button.disabled=true;result.textContent='正在检查辅助程序、网卡和本地端口…';
 try {const d=await checkLocal(chrome.runtime,origin);result.textContent=(d.ok?'✓ ':'')+messageFor(d.code)}
 finally {button.disabled=false}
});
