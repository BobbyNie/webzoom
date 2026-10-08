import {useCallback,useEffect,useRef,useState} from 'react';
import {captureScreen,checkCapabilities,Publisher,Viewer,type MediaStats} from './media';
import {profiles} from './quality';
import type {Control,Identity,Room} from './types';

function Icon({kind='screen'}:{kind?:'screen'|'link'|'arrow'|'lock'|'expand'|'stop'|'people'}){
 const paths={screen:'M3 4h18v12H3z M8 21h8 M12 16v5',link:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',arrow:'M5 12h14 M13 6l6 6-6 6',lock:'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4',expand:'M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5',stop:'M6 6h12v12H6z',people:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0'};
 return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]}/></svg>;
}
class APIError extends Error{constructor(public status:number,message:string){super(message)}}
async function request<T>(path:string,csrf?:string,body?:unknown):Promise<T>{
 const res=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf??''},body:body===undefined?undefined:JSON.stringify(body)});
 if(!res.ok)throw new APIError(res.status,await res.text());return res.status===204?undefined as T:res.json();
}
const blankStats:MediaStats={width:0,height:0,fps:0,level:0,frames:0};
export default function App(){
 const roomID=location.pathname.startsWith('/m/')?location.pathname.slice(3):'';
 const [identity,setIdentity]=useState<Identity|null|undefined>(undefined),[room,setRoom]=useState<Room|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[capability,setCapability]=useState('正在检查浏览器…'),[connected,setConnected]=useState(false),[terminal,setTerminal]=useState(false),[stalled,setStalled]=useState(false),[busy,setBusy]=useState(false),[sharing,setSharing]=useState(false),[stats,setStats]=useState<MediaStats>(blankStats),[target,setTarget]=useState(''),[endDialog,setEndDialog]=useState(false),[joinLink,setJoinLink]=useState(''),[fullscreen,setFullscreen]=useState(false);
 const stagePanel=useRef<HTMLElement>(null);
 const canvas=useRef<HTMLCanvasElement>(null),socket=useRef<WebSocket|null>(null),publisher=useRef<Publisher|null>(null),viewer=useRef<Viewer|null>(null),roomRef=useRef<Room|null>(null),offset=useRef(0),minRTT=useRef(Infinity),lastVideo=useRef(0),lastFeedback=useRef(0),lastKeyRequest=useRef(0),captured=useRef<MediaStream|null>(null);
 const send=useCallback((v:unknown)=>{if(socket.current?.readyState===WebSocket.OPEN)socket.current.send(JSON.stringify(v));},[]);
 const stopLocal=useCallback(()=>{publisher.current?.stop();publisher.current=null;captured.current?.getTracks().forEach(t=>t.stop());captured.current=null;setSharing(false);},[]);
 useEffect(()=>{request<Identity>('/api/me').then(setIdentity).catch(e=>{if(e.status!==401)setError('无法连接服务。请检查网络后重试。');setIdentity(null)});checkCapabilities().then(()=>setCapability('')).catch(e=>setCapability(e.message));},[]);
 useEffect(()=>{
  if(!identity||!roomID||!canvas.current)return;
  let disposed=false,timer:ReturnType<typeof setTimeout>,attempts=0;
  const keyframe=()=>{if(Date.now()-lastKeyRequest.current>=500){lastKeyRequest.current=Date.now();send({type:'keyframe'})}};
  const congestion=()=>{if(Date.now()-lastFeedback.current>=1000){lastFeedback.current=Date.now();send({type:'feedback',level:1})}};
  viewer.current=new Viewer(canvas.current,()=>offset.current,keyframe,congestion,s=>{setStats(s);setStalled(false)});
  function apply(next:Room){
   const previous=roomRef.current;
   if(next.epoch!==previous?.epoch||next.active!==previous?.active){viewer.current?.reset(next.epoch);setStats(blankStats);lastVideo.current=Date.now();setStalled(false);}
   if(previous?.active&&!next.active&&!next.participants.some(p=>p.id===previous.publisherId))setStalled(true);
   if(publisher.current&&(next.publisherId!==identity!.user.id||!next.active||next.epoch!==previous?.epoch))stopLocal();
   roomRef.current=next;setRoom(next);viewer.current?.setLevel(next.quality??0);
  }
  async function connect(){
   try{const next=await request<Room>(`/api/rooms/${encodeURIComponent(roomID)}`);if(disposed)return;apply(next);}catch(e){if(disposed)return;const status=(e as APIError).status;if(status===401){setError('登录已过期。请重新登录。');setIdentity(null);return}if(status===404){setError('会议已结束或已过期。');setTerminal(true);return}schedule();return;}
   const ws=new WebSocket(`${location.origin.replace('https:','wss:')}/api/rooms/${encodeURIComponent(roomID)}/ws`);socket.current=ws;ws.binaryType='arraybuffer';
   ws.onopen=()=>{if(disposed){ws.close();return}setConnected(true);setNotice('');attempts=0;send({type:'clock',clientTime:Date.now()});};
   ws.onmessage=ev=>{if(disposed)return;if(ev.data instanceof ArrayBuffer){if(roomRef.current?.active&&!publisher.current){lastVideo.current=Date.now();viewer.current?.receive(ev.data)}return;}
    try{const msg=JSON.parse(ev.data) as Control;switch(msg.type){case 'room':if(msg.room)apply(msg.room);break;case 'keyframe':publisher.current?.keyframe();break;case 'congestion':publisher.current?.congested();break;case 'clock':if(msg.clientTime&&msg.serverTime){const rtt=Date.now()-msg.clientTime;if(rtt<minRTT.current){minRTT.current=rtt;offset.current=msg.serverTime-(msg.clientTime+Date.now())/2;}}break;}}catch{setError('服务返回了无效的控制消息。');}
   };
   ws.onclose=()=>{if(disposed)return;socket.current=null;roomRef.current=null;setConnected(false);stopLocal();viewer.current?.reset(0);setStats(blankStats);schedule();};
  }
  function schedule(){if(disposed)return;attempts++;if(attempts>8){setError('连接失败。请检查网络，或关闭同一账号打开的其他会议标签页。');setTerminal(true);return};setNotice('连接已中断，正在重新连接…');timer=setTimeout(connect,Math.min(1000*2**(attempts-1),10000));}
  void connect();
  const heartbeat=setInterval(()=>{send({type:'clock',clientTime:Date.now()});if(roomRef.current?.active&&!publisher.current&&Date.now()-lastVideo.current>3000){setStalled(true);viewer.current?.clear();keyframe();}},3000);
  return()=>{disposed=true;clearTimeout(timer);clearInterval(heartbeat);socket.current?.close();socket.current=null;stopLocal();viewer.current?.close();viewer.current=null;};
 },[identity,roomID,send,stopLocal]);
 useEffect(()=>{
  const syncFullscreen=()=>setFullscreen(!!stagePanel.current&&document.fullscreenElement===stagePanel.current);
  document.addEventListener('fullscreenchange',syncFullscreen);
  return()=>document.removeEventListener('fullscreenchange',syncFullscreen);
 },[]);
 async function toggleFullscreen(){
  setError('');
  const exiting=document.fullscreenElement===stagePanel.current;
  try{
   if(exiting)await document.exitFullscreen();
   else await stagePanel.current?.requestFullscreen({navigationUI:'hide'});
  }catch{setError(exiting?'浏览器未能退出全屏。请按 Esc 退出。':'浏览器未能进入全屏。请重试或检查浏览器权限。');}
 }
 async function action(action:string,target?:string){if(!identity)throw new Error('请先登录');return request<Room>(`/api/rooms/${encodeURIComponent(roomID)}/actions`,identity.csrf,{action,target:target??''});}
 async function start(){setBusy(true);setError('');let started=false;try{
  const stream=await captureScreen();captured.current=stream;
  if(!socket.current||socket.current.readyState!==WebSocket.OPEN||roomRef.current?.publisherId!==identity?.user.id){stream.getTracks().forEach(t=>t.stop());throw new Error('共享权限或连接已变化。请重试。');}
  const next=await action('start');started=true;
  if(!captured.current||socket.current?.readyState!==WebSocket.OPEN){throw new Error('连接已中断。');}
  roomRef.current=next;setRoom(next);viewer.current?.reset(next.epoch);setStats(blankStats);
  const p=new Publisher(stream,next.epoch,socket.current,()=>offset.current,canvas.current!,s=>{setStats(s);send({type:'quality',level:s.level})},e=>{setError(`共享失败：${e.message}`);stopLocal();void action('stop').catch(()=>{});});
  publisher.current=p;stream.getVideoTracks()[0].onended=()=>{stopLocal();void action('stop').catch(()=>{});};await p.start();setSharing(true);
 }catch(e){stopLocal();if(started)void action('stop').catch(()=>{});const err=e as Error;setError(err.name==='NotAllowedError'?'未开始共享：授权已取消或被浏览器拒绝。':err.message);}finally{setBusy(false);}}
 async function perform(fn:()=>Promise<unknown>){setBusy(true);setError('');try{await fn();}catch(e){const err=e as APIError;setError(err.status===403?'你没有执行此操作的权限。':err.status===429?'会议人数或会议数量已达到上限。':err.message);}finally{setBusy(false)}}
 const owner=identity?.user.id===room?.ownerId,canPublish=identity?.user.id===room?.publisherId;
 const active=!!room?.active&&connected&&!stalled;
 const state=stalled||(!connected&&room?.active)?'共享已中断':active?'正在共享':'等待共享';
 const loginHref=`/auth/login?next=${encodeURIComponent(roomID?`/m/${roomID}`:'/')}`;
 return <div className="app-shell">
  <header className="app-header"><a href="/" className="brand" aria-label="WebZoom 首页"><span className="brand-icon"><Icon/></span><span>WebZoom<span className="brand-dot">.</span></span></a><div className="header-right"><span className="network-tag"><i/>内网工作空间</span>{identity&&<><span className="user-name">{identity.user.name}</span><button className="text-button" onClick={()=>perform(async()=>{await request('/auth/logout',identity.csrf,{});location.assign('/')})}>退出</button></>}</div></header>
  {error&&<div className="banner error" role="alert"><span>{error}</span><button className="text-button" aria-label="关闭错误提示" onClick={()=>setError('')}>×</button></div>}
  {notice&&<div className="banner" role="status">{notice}</div>}
  {identity===undefined?<main className="loading" aria-live="polite">正在连接工作空间…</main>:!identity?<main className="landing"><section className="hero-copy"><p className="eyebrow">PRIVATE SCREEN SHARING</p><h1>把画面，<br/>带到同一页<span className="brand-dot">。</span></h1><p className="hero-description">为内网协作设计的屏幕共享。<br/>无需安装软件，只分享你选择的画面。</p><a className="button primary large" href={loginHref}>使用公司账号登录<Icon kind="arrow"/></a><p className="small-note"><Icon kind="lock"/>由公司 Keycloak 验证身份</p></section><ScreenIllustration/><div className="principles"><div><span>01</span><strong>只共享屏幕</strong><p>不采集声音，不开启摄像头。</p></div><div><span>02</span><strong>链接即入口</strong><p>同事登录后，通过链接加入。</p></div><div><span>03</span><strong>内网传输</strong><p>画面通过加密的 WSS 连接转发。</p></div></div></main>:!roomID?<main className="dashboard"><p className="eyebrow">YOUR WORKSPACE</p><h1>你好，{identity.user.name}<span className="brand-dot">。</span></h1><p className="subtitle">打开一场会议，让同事看到你的想法。</p><div className="dashboard-grid"><section className="create-card"><span className="feature-icon"><Icon/></span><h2>从你的屏幕开始</h2><p>创建会议，复制链接，然后选择要共享的内容。</p><button className="button primary large" disabled={busy} onClick={()=>perform(async()=>{const r=await request<Room>('/api/rooms',identity.csrf,{});location.assign(`/m/${r.id}`)})}>创建会议<Icon kind="arrow"/></button><p className="small-note">你将成为主持人，可以转交共享权。</p></section><section className="join-card"><p className="eyebrow">ALREADY INVITED?</p><h2>加入同事的会议</h2><label htmlFor="meeting-link">会议链接</label><input id="meeting-link" placeholder={`${location.origin}/m/…`} value={joinLink} onChange={e=>setJoinLink(e.target.value)}/><button className="button secondary" onClick={()=>{try{const u=new URL(joinLink,location.origin);if(u.origin!==location.origin||!/^\/m\/[A-Za-z0-9_-]+$/.test(u.pathname))throw new Error();location.assign(u.pathname)}catch{setError('请输入本站的有效会议链接。')}}}>加入会议<Icon kind="arrow"/></button><div className="privacy-note"><Icon kind="lock"/><p>所有参与者都需要登录。<br/>会议画面不会被录制或保存。</p></div></section></div>{capability&&<p className="compatibility" role="status">{capability}</p>}</main>:<main className="meeting-page">
   <div className="meeting-heading"><div><p className="eyebrow">SCREEN ROOM / {roomID.slice(0,8).toUpperCase()}</p><h1>{owner?'你的会议':'屏幕共享会议'}</h1></div><div className="meeting-heading-actions"><span className={`status-pill ${connected?'online':''}`}><i/>{terminal?'会议不可用':connected?'已连接':'连接中'}</span><button className="button secondary compact" onClick={()=>perform(async()=>{await navigator.clipboard.writeText(location.href);setNotice('会议链接已复制。请发送给已登录的同事。')})}><Icon kind="link"/>复制会议链接</button></div></div>
   <div className="meeting-grid"><section className="stage-panel" ref={stagePanel}><div className="stage-top"><span className="stage-state" data-testid="share-state"><i className={active?'live-dot':''}/>{state}</span><span>{room?.participants.find(p=>p.id===room.publisherId)?.name??'共享者'}{sharing?' · 你的屏幕':''}</span></div><div className="screen-stage"><canvas ref={canvas} className={active?'screen-canvas':'screen-canvas hidden'} aria-label="共享画面"/>{!active&&<div className="stage-placeholder"><div className="stage-icon"><Icon/></div><h2>{terminal?'会议已结束':stalled?'画面传输已中断':canPublish?'你的屏幕，准备就绪':'等待共享者开始'}</h2><p>{terminal?'返回工作空间以创建新会议。':canPublish?'点击下方按钮，再选择一个屏幕、窗口或标签页。':'共享开始后，画面会自动显示在这里。'}</p><span>SCREEN ONLY · NO AUDIO</span></div>}</div><div className="stage-bottom"><span>{stats.width?`${stats.width} × ${stats.height} · ${stats.fps} fps`:'等待视频信号'}</span><span>{stats.latency!==undefined?`估算延迟 ${Math.round(stats.latency)} ms`:'VP8 / WSS'}<button className="icon-button" aria-label={fullscreen?'退出全屏':'全屏观看'} title={fullscreen?'退出全屏（Esc）':'全屏观看'} aria-pressed={fullscreen} onClick={()=>void toggleFullscreen()}><Icon kind="expand"/></button></span></div>
    <div className="toolbar"><div>{canPublish&&(sharing?<button className="button secondary" disabled={busy} onClick={()=>perform(async()=>{stopLocal();await action('stop')})}><Icon kind="stop"/>停止共享</button>:<button className="button primary" disabled={busy||!connected||!!capability||terminal} onClick={start}><Icon/>共享屏幕</button>)}{!canPublish&&<span className="viewer-label"><Icon kind="lock"/>你正在以听众身份参与</span>}</div><div>{owner&&<button className="button danger" disabled={!room||terminal} onClick={()=>setEndDialog(true)}>结束会议</button>}<a className="text-button" href="/">离开会议</a></div></div>
   </section><aside className="participants-panel"><div className="participants-heading"><h2><Icon kind="people"/>参与者</h2><span>{room?.participants.length??0}</span></div><p className="panel-description">每次仅有一人共享屏幕。</p><ul>{room?.participants.map(p=><li key={p.id}><span className="avatar">{p.name.slice(0,1).toUpperCase()}</span><div><strong>{p.name}{p.id===identity.user.id?'（你）':''}</strong><small>{p.id===room.ownerId?'主持人':p.id===room.publisherId?'共享者':'听众'}</small></div>{p.id===room.publisherId&&<span className="publisher-badge" title="当前共享者"><Icon/></span>}</li>)}</ul>{owner&&<div className="transfer"><label htmlFor="publisher">共享者</label><select id="publisher" value={target||room?.publisherId||''} onChange={e=>setTarget(e.target.value)}>{room?.participants.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select><button className="button secondary" disabled={busy||!connected||!(target||room?.publisherId)||terminal} onClick={()=>perform(async()=>{await action('transfer',target||room?.publisherId);setNotice('共享权已转交。新共享者需要主动选择屏幕。')})}>转交共享权</button><p>转交会停止当前共享。主持人可以随时收回共享权。</p></div>}<div className={`quality-card ${(room?.quality??0)>0?'degraded':''}`}><p className="eyebrow">STREAM STATUS</p><strong>{(room?.quality??0)>0?'已自动降低画质':'标准画质'}</strong><p>{profiles[room?.quality??0]?.label??'1080p · 30 fps'}</p><small>已处理 <span data-testid="frames">{stats.frames}</span> 帧</small></div></aside></div>
   {capability&&<p className="compatibility" role="status">{capability}</p>}
   <div className="meeting-footnote"><span><Icon kind="lock"/>不录制 · 不采集声音 · 不开启摄像头</span><span>登录有效期至 {new Date(identity.expiresAt).toLocaleTimeString()}</span></div>
  </main>}
  <footer className="app-footer"><span>WEBZOOM / 内网协作</span><span>让沟通更直观。</span></footer>
  {endDialog&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="end-title"><p className="eyebrow">END SESSION</p><h2 id="end-title">结束这场会议？</h2><p>所有参与者将断开连接。此会议链接将失效。</p><div><button className="button secondary" onClick={()=>setEndDialog(false)}>取消</button><button className="button danger" onClick={()=>perform(async()=>{await action('end');setEndDialog(false);setTerminal(true);setNotice('会议已结束。')})}>确认结束</button></div></section></div>}
 </div>;
}
function ScreenIllustration(){return <div className="screen-illustration" aria-hidden="true"><div className="illustration-label"><span className="live-dot"/>一个画面，共同关注</div><div className="illustration-window"><div className="window-bar"><i/><i/><i/><span>DESIGN REVIEW / 01</span></div><div className="illustration-content"><div className="abstract-sidebar"><b/><i/><i/><i/></div><div className="abstract-main"><small>TEAM WORKSPACE</small><strong>Good ideas.<br/>Shared clearly.</strong><div className="abstract-chart"><i/><i/><i/><i/><i/></div></div></div></div><div className="floating-note"><span className="mini-avatar">W</span><div><b>屏幕共享中</b><small>加密连接 · 仅限内网</small></div><Icon/></div></div>}
