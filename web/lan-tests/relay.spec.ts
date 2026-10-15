import {test,expect,type Page} from '@playwright/test';
async function login(page:Page,name:string){await page.goto('/');await page.getByRole('link',{name:'使用公司账号登录'}).click();await page.getByLabel('用户名').fill(name);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'创建会议',exact:true})).toBeVisible()}
// This is a native/UDP simulator, NOT an actual Chrome host or office network test.
async function nativeSimulator(page:Page,others:Page[]){await page.exposeBinding('lanTestBus',async(_,packet)=>{await Promise.all(others.filter(p=>p!==page&&!p.isClosed()).map(p=>p.evaluate(packet=>{(window as any).lanTestDeliver?.(packet)},packet)))});await page.addInitScript(()=>{
 sessionStorage.setItem('webzoom-lan','true');let channel='',state:any=null;let stopped=false;let inbound:number[]=[];let serial=0;
 const reply=(message:any)=>window.postMessage({source:'webzoom-lan-extension-v1',channel,message},location.origin);
 const b64=(b:Uint8Array)=>{let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode(...b.subarray(i,i+8192));return btoa(s)};
 const deliver=(raw:Uint8Array,generation:string)=>{const id=generation+'-'+(++serial),count=Math.ceil(raw.length/32768);for(let index=0;index<count;index++)reply({type:'chunk',id,index,count,data:b64(raw.subarray(index*32768,(index+1)*32768))})};
 (window as any).lanTestFail=()=>{stopped=true;reply({type:'error'})};
 (window as any).lanTestRole=()=>state?.role;
 (window as any).lanTestDeliver=(packet:any)=>{if(stopped||!state)return;if(packet.type==='probe'&&packet.room===state.room&&packet.node!==state.node)reply({type:'seen',node:packet.node,token:packet.token});if(packet.type==='media'&&packet.group===state.group&&packet.generation===state.generation&&state.role==='receiver')deliver(new Uint8Array(packet.raw),packet.generation)};
 setInterval(()=>{if(channel&&!stopped)reply({type:'heartbeat'})},1000);
 window.addEventListener('message',async event=>{const v=event.data;if(v?.source!=='webzoom-lan-page-v1')return;const m=v.message;if(m.type==='connect'){channel=v.channel;stopped=false;reply({type:'connected'});return}if(v.channel!==channel||stopped)return;
 switch(m.type){case 'start':reply({type:'started',protocol:1});break;case 'configure':{const changed=state?.generation!==m.state.generation;state=m.state;if(changed)reply({type:'configured',generation:state.generation,role:state.role});break}
 case 'probe':await (window as any).lanTestBus({type:'probe',...m.state});break;
 case 'chunk':{if(m.index===0)inbound=[];inbound.push(...Uint8Array.from(atob(m.data),c=>c.charCodeAt(0)));reply({type:'ack',id:m.id,index:m.index});if(m.index!==m.count-1)break;const signed=new Uint8Array(inbound);const current={...state};const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(current.public),c=>c.charCodeAt(0)),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,signed.slice(-64),signed.slice(0,-64)))throw Error('Server signature rejected');const generation=Array.from(signed.slice(20,36),b=>b.toString(16).padStart(2,'0')).join('');if(generation!==current.generation)break;const raw=signed.slice(36,-64);deliver(raw,generation);await (window as any).lanTestBus({type:'media',group:current.group,generation,raw:Array.from(raw)});break}
 case 'stop':stopped=true;break;
 }});
})}
test('LAN simulated bridge keeps one feed, renders VP8, and re-elects after native failure',async({browser})=>{
 const contexts=await Promise.all([0,1,2].map(()=>browser.newContext({ignoreHTTPSErrors:true})));const [owner,a,b]=await Promise.all(contexts.map(c=>c.newPage()));const peers=[a,b];await nativeSimulator(a,peers);await nativeSimulator(b,peers);
 await owner.addInitScript(()=>{navigator.mediaDevices.getDisplayMedia=async()=>{const c=document.createElement('canvas');c.width=640;c.height=360;const ctx=c.getContext('2d')!;let n=0;setInterval(()=>{ctx.fillStyle=n++%2?'#007766':'#445588';ctx.fillRect(0,0,640,360);ctx.fillStyle='white';ctx.font='28px sans-serif';ctx.fillText('LAN '+n,30,70)},100);return c.captureStream(10)}});
 await login(owner,'LAN-owner');await owner.getByRole('button',{name:'创建会议',exact:true}).click();await expect(owner).toHaveURL(/\/m\//);const link=owner.url();await login(a,'LAN-a');await a.goto(link);await login(b,'LAN-b');await b.goto(link);
 await expect.poll(async()=>[await a.evaluate(()=>(window as any).lanTestRole()),await b.evaluate(()=>(window as any).lanTestRole())].sort().join(',')).toBe('receiver,relay');
 await owner.getByRole('button',{name:'共享屏幕',exact:true}).click();for(const p of peers)await expect.poll(async()=>Number(await p.getByTestId('frames').textContent())).toBeGreaterThan(3);
 const relay=await a.evaluate(()=>(window as any).lanTestRole())==='relay'?a:b;const receiver=relay===a?b:a;await relay.evaluate(()=>(window as any).lanTestFail());await expect(receiver.getByRole('status').filter({hasText:'局域网中继'})).toBeVisible();await expect.poll(async()=>Number(await receiver.getByTestId('frames').textContent())).toBeGreaterThan(10);
 for(const c of contexts)await c.close();
});
test('missing extension stays control-only instead of automatic direct fallback',async({page})=>{await page.addInitScript(()=>sessionStorage.setItem('webzoom-lan','true'));await login(page,'LAN-missing');await page.getByRole('button',{name:'创建会议',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'未连接到扩展或辅助程序'})).toBeVisible({timeout:10000});await expect(page.getByRole('button',{name:'退出局域网分流 / 安装客户端'})).toBeVisible()});
