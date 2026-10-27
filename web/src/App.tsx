import {ControlProbe} from './controlProbe';
import {reconnectDelay,withConnectionDeadline,watchSocketOpening} from './reconnect';
import Annotations from './ScreenAnnotations';
import PresenterFeedback from './PresenterFeedback';
import AnnotationRequests from './AnnotationRequests';
import {testBuild} from './testBuild';
import {BrowserRelay,emptyRelayStatus} from './browserRelay';
import BrowserRelayPanel from './BrowserRelayPanel';
import type {BrowserOverview} from './browserRelayProtocol';
import {initialView,applyAnnotation,emptyAnnotations,type ViewTransform,type AnnotationCommand,type AnnotationState} from './annotations';
import {useCallback,useEffect,useRef,useState} from 'react';
import {captureScreen,checkCapabilities,Publisher,Viewer,type MediaStats} from './media';
import StreamQuality from './StreamQuality';
import type {Control,Identity,Room} from './types';
import {APIError,request,isBandwidthLimitError,bandwidthMessage} from './api';
import {MyMeetings} from './MyMeetings';
import {keepSessionAlive} from './session';
import {leaveMeeting} from './leave';
import {confirmSharingControl,withSharingDeadline} from './sharingControl';

function Icon({kind='screen'}:{kind?:'screen'|'link'|'arrow'|'lock'|'expand'|'stop'|'people'}){
 const paths={screen:'M3 4h18v12H3z M8 21h8 M12 16v5',link:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',arrow:'M5 12h14 M13 6l6 6-6 6',lock:'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4',expand:'M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5',stop:'M6 6h12v12H6z',people:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0'};
 return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]}/></svg>;
}
const blankStats:MediaStats={width:0,height:0,fps:0,level:0,frames:0};
export default function App(){
 const roomID=location.pathname.startsWith('/m/')?location.pathname.slice(3):'';
 const [identity,setIdentity]=useState<Identity|null|undefined>(undefined),[room,setRoom]=useState<Room|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[capability,setCapability]=useState('正在检查浏览器…'),[connected,setConnected]=useState(false),[terminal,setTerminal]=useState(false),[stalled,setStalled]=useState(false),[busy,setBusy]=useState(false),[sharing,setSharing]=useState(false),[stats,setStats]=useState<MediaStats>(blankStats),[target,setTarget]=useState(''),[endDialog,setEndDialog]=useState(false),[joinLink,setJoinLink]=useState(''),[fullscreen,setFullscreen]=useState(false);
 const [annotations,setAnnotations]=useState<AnnotationState>(emptyAnnotations()),[annotationErrorVersion,setAnnotationErrorVersion]=useState(0);
 const [annotationHost,setAnnotationHost]=useState<HTMLDivElement|null>(null);
 const [view,setView]=useState<ViewTransform>(initialView),[pan,setPan]=useState(false),[focusView,setFocusView]=useState(false),[exportEnabled,setExportEnabled]=useState(false);
 const [renewWarning,setRenewWarning]=useState('');
 const [shareInterruption,setShareInterruption]=useState<{reason:string;at:number}|null>(null);
 const [relayStatus,setRelayStatus]=useState(emptyRelayStatus);
 const [relayOverview,setRelayOverview]=useState<BrowserOverview|null>(null);
 useEffect(()=>{if(!identity){setExportEnabled(false);return}let alive=true;request<{exportEnabled:boolean}>('/api/annotation-policy').then(p=>{if(alive)setExportEnabled(p.exportEnabled===true)}).catch(()=>{if(alive)setExportEnabled(false)});return()=>{alive=false}},[identity?.user.id]);
 useEffect(()=>{setView(initialView);setPan(false)},[room?.epoch,room?.active]);
 const userID=identity?.user.id,csrf=identity?.csrf;
 const leaving=useRef(false),sessionActive=useRef(false),lastActivity=useRef(Date.now());
 sessionActive.current=!!roomID&&!terminal&&(connected||sharing||!!room);
 const stagePanel=useRef<HTMLElement>(null);
 const canvas=useRef<HTMLCanvasElement>(null),socket=useRef<WebSocket|null>(null),publisher=useRef<Publisher|null>(null),viewer=useRef<Viewer|null>(null),roomRef=useRef<Room|null>(null),offset=useRef(0),minRTT=useRef(Infinity),lastVideo=useRef(0),lastFeedback=useRef(0),lastKeyRequest=useRef(0),captured=useRef<MediaStream|null>(null);
 const captureRevision=useRef(0),startAttempt=useRef(0);
 const send=useCallback((v:unknown)=>{if(socket.current?.readyState===WebSocket.OPEN)socket.current.send(JSON.stringify(v));},[]);
 const stopLocal=useCallback(()=>{captureRevision.current++;publisher.current?.stop();publisher.current=null;captured.current?.getTracks().forEach(t=>t.stop());captured.current=null;setSharing(false);},[]);
 const interruptSharing=useCallback((reason:string)=>{if(publisher.current&&!leaving.current)setShareInterruption({reason,at:Date.now()});stopLocal();},[stopLocal]);
 useEffect(()=>{request<Identity>('/api/me').then(setIdentity).catch(e=>{if(e.status!==401)setError('无法连接服务。请检查网络后重试。');setIdentity(null)});checkCapabilities().then(()=>setCapability('')).catch(e=>setCapability(e.message));},[]);
 useEffect(()=>{
  if(!identity||!userID||!csrf)return;
  const activity=(event:Event)=>{if(event.isTrusted)lastActivity.current=Date.now()};
  const events=['pointerdown','keydown','wheel','touchstart'];
  for(const event of events)window.addEventListener(event,activity,{passive:true});
  const stop=keepSessionAlive({
   expiresAt:identity.expiresAt,
   active:()=>sessionActive.current||Date.now()-lastActivity.current<60000,
   renew:signal=>request<Identity>('/auth/refresh',csrf,{},signal),
   inspect:signal=>request<Identity>('/api/me',undefined,undefined,signal),
   onRenewed:setIdentity,
   onExpired:()=>{stopLocal();setIdentity(null);setRenewWarning('');setError('登录已过期。请重新登录。')},
   onUnavailable:()=>setRenewWarning('登录续期暂时失败。系统正在重试；如果登录到期，投屏将停止。'),
   onRecovered:()=>setRenewWarning(''),
  });
  return()=>{stop();for(const event of events)window.removeEventListener(event,activity)};
 },[userID,csrf,stopLocal]);
 useEffect(()=>{
  if(!identity||!roomID||!canvas.current)return;
  let disposed=false,timer:ReturnType<typeof setTimeout>,attempts=0,relay:BrowserRelay|null=null,controlProbe:ControlProbe|null=null;
  const lifetime=new AbortController();let cancelOpening=()=>{};
  setRelayStatus(emptyRelayStatus());
  const keyframe=()=>{if(Date.now()-lastKeyRequest.current>=500){lastKeyRequest.current=Date.now();send({type:'keyframe'})}};
  const congestion=()=>{if(Date.now()-lastFeedback.current>=1000){lastFeedback.current=Date.now();send({type:'feedback',level:1})}};
  viewer.current=new Viewer(canvas.current,()=>offset.current,keyframe,congestion,s=>{setStats(s);setStalled(false)});
  function apply(next:Room){
   const previous=roomRef.current;
   if(next.epoch!==previous?.epoch||next.active!==previous?.active){setAnnotations(emptyAnnotations(next.epoch));viewer.current?.reset(next.epoch);setStats(blankStats);lastVideo.current=Date.now();setStalled(false);}
   if(previous?.active&&!next.active&&!next.participants.some(p=>p.id===previous.publisherId))setStalled(true);
   if(publisher.current&&(next.publisherId!==identity!.user.id||!next.active||next.epoch!==previous?.epoch))interruptSharing(next.publisherId!==identity!.user.id?'共享权限已转交，本次共享已停止。':'服务器已停止或更新本次共享。');
   roomRef.current=next;setRoom(next);viewer.current?.setLevel(next.quality??0);
  }
  async function connect(){
   if(disposed||leaving.current)return;
   try{const next=await withConnectionDeadline(signal=>request<Room>(`/api/rooms/${encodeURIComponent(roomID)}`,undefined,undefined,signal),lifetime.signal);if(disposed||leaving.current)return;apply(next);}catch(e){if(disposed||leaving.current)return;const status=(e as APIError).status;if(status===401){setError('登录已过期。请重新登录。');setIdentity(null);return}if(status===404){setError('会议已结束或已过期。');setTerminal(true);return}if(isBandwidthLimitError(e)){setNotice(bandwidthMessage);timer=setTimeout(connect,5000);return}schedule();return;}
   let ws:WebSocket;
   try{ws=new WebSocket(`${location.origin.replace('https:','wss:')}/api/rooms/${encodeURIComponent(roomID)}/ws?mediaAck=1`)}catch{schedule();return}
   let receivedFrames=0;socket.current=ws;ws.binaryType='arraybuffer';
   ws.onopen=()=>{if(disposed||leaving.current||socket.current!==ws){ws.close();return}setConnected(true);setNotice('');attempts=0;send({type:'clock',clientTime:Date.now()});
    if(roomRef.current?.browserRelayAvailable){controlProbe=new ControlProbe(clientTime=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'clock',clientTime}))});relay=new BrowserRelay({send,frame:raw=>{lastVideo.current=Date.now();viewer.current?.receive(raw)},reset:epoch=>{if(!publisher.current){viewer.current?.reset(epoch);setStats(blankStats)}},keyframe,status:setRelayStatus,now:()=>Date.now()+offset.current,expired:()=>ws.close(),revalidate:()=>controlProbe?.check()??Promise.resolve(false)});relay.hello()}};
   ws.onmessage=ev=>{if(disposed||leaving.current||socket.current!==ws)return;if(ev.data instanceof ArrayBuffer){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'media-ack',sequence:++receivedFrames}));if(roomRef.current?.active&&!publisher.current){if(roomRef.current.browserRelayEnabled)relay?.receive(ev.data);else{lastVideo.current=Date.now();viewer.current?.receive(ev.data)}}return;}
    try{const msg=JSON.parse(ev.data) as Control;relay?.touch();switch(msg.type){case 'browser-overview':if(msg.browserOverview)setRelayOverview({...msg.browserOverview,receivedAt:Date.now()});break;case 'browser-plan':if(msg.browserPlan)relay?.apply(msg.browserPlan);break;case 'browser-signal':if(msg.browserSignal)void relay?.signal(msg.browserSignal);break;case 'annotations':if(msg.annotations&&msg.annotations.epoch===roomRef.current?.epoch)setAnnotations({...msg.annotations,pointers:{}});break;case 'annotation':if(msg.annotation){const event=msg.annotation;setAnnotations(current=>applyAnnotation(current,event))}break;case 'annotation-error':setError(msg.error??'批注未被接受，请重试。');setAnnotationErrorVersion(v=>v+1);break;case 'room':if(msg.room)apply(msg.room);break;case 'keyframe':publisher.current?.keyframe();break;case 'congestion':publisher.current?.congested();break;case 'clock':if(msg.clientTime!==undefined&&msg.clientTime<0){controlProbe?.receive(msg.clientTime);break}if(msg.clientTime&&msg.serverTime){const rtt=Date.now()-msg.clientTime;if(rtt<minRTT.current){minRTT.current=rtt;offset.current=msg.serverTime-(msg.clientTime+Date.now())/2;}}break;}}catch{setError('服务返回了无效的控制消息。');}
   };
   const disconnected=(event?:CloseEvent)=>{if(disposed||socket.current!==ws)return;interruptSharing(`共享连接已断开，本次共享已停止${event?`（连接代码 ${event.code}）`:''}。`);cancelOpening();controlProbe?.dispose();controlProbe=null;relay?.close();relay=null;setRelayStatus(emptyRelayStatus());setRelayOverview(null);socket.current=null;roomRef.current=null;setConnected(false);setAnnotations(emptyAnnotations());viewer.current?.reset(0);setStats(blankStats);schedule();};
   ws.onclose=disconnected;cancelOpening=watchSocketOpening(ws,disconnected);
  }
  function schedule(){if(disposed||leaving.current)return;attempts++;const delay=reconnectDelay(attempts);if(delay===null){setError('连接失败。请检查网络，或关闭同一账号打开的其他会议标签页。');setTerminal(true);return};setNotice('连接已中断，正在重新连接…');timer=setTimeout(connect,delay);}
  void connect();
  const heartbeat=setInterval(()=>{
   send({type:'clock',clientTime:Date.now()});
   const playback=viewer.current;
   if(roomRef.current?.active&&!publisher.current&&(Date.now()-lastVideo.current>3000||(playback&&performance.now()-playback.lastRenderedAt>3000))){setStalled(true);playback?.clear();keyframe();}
  },3000);
  return()=>{disposed=true;lifetime.abort();cancelOpening();controlProbe?.dispose();controlProbe=null;relay?.close();relay=null;clearTimeout(timer);clearInterval(heartbeat);socket.current?.close();socket.current=null;stopLocal();viewer.current?.close();viewer.current=null;};
 },[userID,roomID,send,stopLocal,interruptSharing]);
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
 async function action(action:string,target?:string,epoch?:number,signal?:AbortSignal){if(!identity)throw new Error('请先登录');return request<Room>(`/api/rooms/${encodeURIComponent(roomID)}/actions`,identity.csrf,{action,target:target??'',...(epoch===undefined?{}:{epoch})},signal);}
 async function stopRemote(epoch:number,connection:WebSocket|null=socket.current){
  try{await withSharingDeadline(signal=>action('stop',undefined,epoch,signal),2000)}
  catch(error){if(!await confirmSharingControl(connection,'stop-sharing',epoch))throw error}
 }
 async function stopSharing(){
  const epoch=roomRef.current?.epoch,connection=socket.current;stopLocal();
  if(epoch!==undefined)await stopRemote(epoch,connection);
 }
 async function start(){
  const attempt=++startAttempt.current,revision=++captureRevision.current;
  const connection=socket.current,initial=roomRef.current;
  const current=()=>revision===captureRevision.current&&!leaving.current&&socket.current===connection&&connection?.readyState===WebSocket.OPEN&&roomRef.current?.publisherId===identity?.user.id;
  setBusy(true);setError('');let stream:MediaStream|undefined,startRequested=false;
  try{
   stream=await captureScreen();
   if(!current()||!initial||initial.active||roomRef.current?.epoch!==initial.epoch)throw new Error('共享权限或连接已变化。请重新选择屏幕。');
   captured.current=stream;
   startRequested=true;
   const next=await withSharingDeadline(signal=>action('start',undefined,initial.epoch,signal));
   // WS room events may be newer than this delayed HTTP response. Never roll
   // them back or install a publisher for a replaced stream/transport/epoch.
   if(!current()||captured.current!==stream||!next.active||roomRef.current!.epoch>next.epoch||stream.getVideoTracks()[0]?.readyState!=='live')throw new Error('共享状态已变化。请重试。');
   roomRef.current=next;setRoom(next);viewer.current?.reset(next.epoch);setStats(blankStats);
   const p=new Publisher(stream,next.epoch,connection!,()=>offset.current,canvas.current!,s=>{setStats(s);send({type:'quality',level:s.level})},e=>{
    if(publisher.current!==p)return;
    setError(`共享失败：${e.message}`);interruptSharing('屏幕采集或编码发生错误，本次共享已停止。');void stopRemote(next.epoch,connection).catch(()=>{});
   });
   publisher.current=p;
   stream.getVideoTracks()[0].onended=()=>{if(publisher.current!==p)return;interruptSharing('浏览器已结束屏幕采集，本次共享已停止。');void stopRemote(next.epoch,connection).catch(()=>{});};
   await p.start();
   if(!current()||publisher.current!==p||!roomRef.current?.active||roomRef.current.epoch!==next.epoch)throw new Error('共享状态已变化。请重试。');
   setShareInterruption(null);setSharing(true);
  }catch(e){
   // A stale attempt owns only its own tracks, not a replacement publisher.
   stream?.getTracks().forEach(t=>t.stop());
   if(revision===captureRevision.current){stopLocal();const err=e as Error;setError(err.name==='NotAllowedError'?'未开始共享：授权已取消或被浏览器拒绝。':err.message);}
   // Fence even an unknown outcome: aborting HTTP cannot recall a queued start.
   if(startRequested&&initial)await confirmSharingControl(connection,'cancel-start',initial.epoch);
  }finally{if(attempt===startAttempt.current)setBusy(false);}
 }
 async function perform(fn:()=>Promise<unknown>){setBusy(true);setError('');try{await fn();}catch(e){const err=e as APIError;if(err.status===401){onUnauthorized();return}setError(isBandwidthLimitError(err)?bandwidthMessage:err.status===403?'你没有执行此操作的权限。':err.code==='annotation_request_rate'?'申请过于频繁，请稍等 10 秒后重试。':err.status===429?'当前环境启用了压力测试容量限制。请联系维护人员检查测试配置。':err.message);}finally{setBusy(false)}}
 const onUnauthorized=useCallback(()=>{setError('登录已过期。请重新登录。');setIdentity(null);},[]);
 const owner=identity?.user.id===room?.ownerId,canPublish=identity?.user.id===room?.publisherId;
 const active=!!room?.active&&connected&&!stalled;
 const state=stalled||(!connected&&room?.active)?'共享已中断':active?'正在共享':shareInterruption&&canPublish?'共享已停止':'等待共享';
 const loginHref=`/auth/login?next=${encodeURIComponent(roomID?`/m/${roomID}`:'/')}`;
 return <div className="app-shell">
  <header className="app-header"><a href="/" className="brand" aria-label="WebZoom 首页"><span className="brand-icon"><Icon/></span><span>WebZoom<span className="brand-dot">.</span></span></a><div className="header-right"><span className="network-tag"><i/>内网工作空间</span>{identity&&<><span className="user-name">{identity.user.name}</span><button className="text-button" onClick={()=>perform(async()=>{await request('/auth/logout',identity.csrf,{});location.assign('/')})}>退出</button></>}</div></header>
  {renewWarning&&<p className="compatibility" role="status">{renewWarning}</p>}{error&&<div className="banner error" role="alert"><span>{error}</span><button className="text-button" aria-label="关闭错误提示" onClick={()=>setError('')}>×</button></div>}
  {notice&&<div className="banner" role="status">{notice}</div>}
  {identity===undefined?<main className="loading" aria-live="polite">正在连接工作空间…</main>:!identity?<main className="landing"><section className="hero-copy"><p className="eyebrow">PRIVATE SCREEN SHARING</p><h1>把画面，<br/>带到同一页<span className="brand-dot">。</span></h1><p className="hero-description">为内网协作设计的屏幕共享。<br/>无需安装软件，只分享你选择的画面。</p><a className="button primary large" href={loginHref}>使用公司账号登录<Icon kind="arrow"/></a><p className="small-note"><Icon kind="lock"/>由公司 Keycloak 验证身份</p></section><ScreenIllustration/><div className="principles"><div><span>01</span><strong>只共享屏幕</strong><p>不采集声音，不开启摄像头。</p></div><div><span>02</span><strong>链接即入口</strong><p>同事登录后，通过链接加入。</p></div><div><span>03</span><strong>内网传输</strong><p>画面通过加密的 WSS 连接转发。</p></div></div></main>:!roomID?<main className="dashboard"><p className="eyebrow">YOUR WORKSPACE</p><h1>你好，{identity.user.name}<span className="brand-dot">。</span></h1><p className="subtitle">打开一场会议，让同事看到你的想法。</p><div className="dashboard-grid"><section className="create-card"><span className="feature-icon"><Icon/></span><h2>从你的屏幕开始</h2><p>创建会议，复制链接，然后选择要共享的内容。</p><button className="button primary large" disabled={busy} onClick={()=>perform(async()=>{const r=await request<Room>('/api/rooms',identity.csrf,{});location.assign(`/m/${r.id}`)})}>创建会议<Icon kind="arrow"/></button><p className="small-note">你将成为主持人，可以转交共享权。</p></section><section className="join-card"><p className="eyebrow">ALREADY INVITED?</p><h2>加入同事的会议</h2><label htmlFor="meeting-link">会议链接</label><input id="meeting-link" placeholder={`${location.origin}/m/…`} value={joinLink} onChange={e=>setJoinLink(e.target.value)}/><button className="button secondary" onClick={()=>{try{const u=new URL(joinLink,location.origin);if(u.origin!==location.origin||!/^\/m\/[A-Za-z0-9_-]+$/.test(u.pathname))throw new Error();location.assign(u.pathname)}catch{setError('请输入本站的有效会议链接。')}}}>加入会议<Icon kind="arrow"/></button><div className="privacy-note"><Icon kind="lock"/><p>所有参与者都需要登录。<br/>会议画面不会被录制或保存。</p></div></section></div><MyMeetings identity={identity} onUnauthorized={onUnauthorized}/>
   {capability&&<p className="compatibility" role="status">{capability}</p>}</main>:<main className="meeting-page">
   <div className="meeting-heading"><div><p className="eyebrow">SCREEN ROOM / {roomID.slice(0,8).toUpperCase()}</p><h1>{owner?'你的会议':'屏幕共享会议'}</h1></div><div className="meeting-heading-actions"><span className={`status-pill ${connected?'online':''}`}><i/>{terminal?'会议不可用':connected?'已连接':'连接中'}</span><button className="button secondary compact" onClick={()=>perform(async()=>{await navigator.clipboard.writeText(location.href);setNotice('会议链接已复制。请发送给已登录的同事。')})}><Icon kind="link"/>复制会议链接</button></div></div>
   <div className={`meeting-grid ${focusView?'focus-view':''}`}><section className="stage-panel" ref={stagePanel}>{shareInterruption&&<div className="sharing-interruption" role="alert" data-testid="share-interruption"><div><strong>共享已停止</strong><span>{shareInterruption.reason}</span><small>发生于 {new Date(shareInterruption.at).toLocaleTimeString()}。{canPublish?'连接恢复不会自动重新共享；如需继续，请点击“共享屏幕”并重新选择画面。':'本机不会自动重新共享；请先确认当前共享权限。'}</small></div><button type="button" className="text-button" aria-label="关闭共享中断提示" onClick={()=>setShareInterruption(null)}>知道了</button></div>}<div className="stage-top"><span className="stage-state" data-testid="share-state"><i className={active?'live-dot':''}/>{state}</span><span>{room?.participants.find(p=>p.id===room.publisherId)?.name??'共享者'}{sharing?' · 你的屏幕':''}</span></div><div className="meeting-view-controls" aria-label="观看设置"><button type="button" aria-pressed={focusView} onClick={()=>setFocusView(v=>!v)}>{focusView?'显示参与者':'专注观看'}</button><button type="button" aria-label="缩小画面" disabled={view.scale<=1} onClick={()=>{setView(v=>({...v,scale:Math.max(1,v.scale-.25),x:0,y:0}));setPan(false)}}>−</button><span aria-label="画面缩放比例">{Math.round(view.scale*100)}%</span><button type="button" aria-label="放大画面" disabled={!active||view.scale>=3} onClick={()=>setView(v=>({...v,scale:Math.min(3,v.scale+.25)}))}>＋</button><button type="button" aria-pressed={pan} disabled={view.scale<=1} onClick={()=>setPan(v=>!v)}>拖动画面</button><button type="button" onClick={()=>{setView(initialView);setPan(false)}}>适应窗口</button><span role="status">{terminal?'会议不可用':!connected?'正在重新连接':stalled?'画面暂时中断':active?'画面接收中':'等待共享'}</span></div><div className="screen-stage"><canvas ref={canvas} style={{transform:`translate(${view.x*100}%,${view.y*100}%) scale(${view.scale})`}} className={active?'screen-canvas':'screen-canvas hidden'} aria-label="共享画面"/><Annotations toolbarHost={annotationHost} clockOffset={offset.current} view={view} pan={pan} onView={setView} onExitPan={()=>setPan(false)} exportEnabled={exportEnabled} canvas={canvas.current} state={annotations.epoch===room?.epoch?annotations:emptyAnnotations(room?.epoch??0)} user={identity.user} owner={owner} allowed={!!owner||!!room?.annotators?.includes(identity.user.id)} active={active} width={stats.width} height={stats.height} errorVersion={annotationErrorVersion} send={(annotation:AnnotationCommand)=>send({type:"annotation",annotation})}/>{!active&&<div className="stage-placeholder"><div className="stage-icon"><Icon/></div><h2>{terminal?'会议已结束':stalled?'画面传输已中断':canPublish?'你的屏幕，准备就绪':'等待共享者开始'}</h2><p>{terminal?'返回工作空间以创建新会议。':canPublish?'点击下方按钮，再选择一个屏幕、窗口或标签页。':'共享开始后，画面会自动显示在这里。'}</p><span>SCREEN ONLY · NO AUDIO</span></div>}</div><div className="stage-bottom"><span>{active&&stats.width?`${stats.width} × ${stats.height} · ${stats.fps} fps`:'等待视频信号'}</span><span>{active&&stats.latency!==undefined?`估算延迟 ${Math.round(stats.latency)} ms`:'VP8 / WSS'}<button className="icon-button" aria-label={fullscreen?'退出全屏':'全屏观看'} title={fullscreen?'退出全屏（Esc）':'全屏观看'} aria-pressed={fullscreen} onClick={()=>void toggleFullscreen()}><Icon kind="expand"/></button></span></div>
    <div className="toolbar"><div>{canPublish&&(sharing?<button className="button secondary" disabled={busy} onClick={()=>perform(stopSharing)}><Icon kind="stop"/>停止共享</button>:<button className="button primary" disabled={busy||!connected||!!capability||terminal} onClick={start}><Icon/>共享屏幕</button>)}{!canPublish&&<span className="viewer-label"><Icon kind="lock"/>你正在以听众身份参与</span>}</div><div className="annotation-dock" ref={setAnnotationHost}/><div>{owner&&<button className="button danger" disabled={!room||terminal} onClick={()=>perform(async()=>{if(document.fullscreenElement)await document.exitFullscreen();setEndDialog(true)})}>结束会议</button>}<a className="text-button" href="/" onClick={event=>{event.preventDefault();if(leaving.current)return;leaving.current=true;stopLocal();void leaveMeeting({notify:signal=>identity&&roomID?request(`/api/rooms/${encodeURIComponent(roomID)}/actions`,identity.csrf,{action:'leave'},signal):Promise.resolve(),fallback:()=>send({type:'leave'}),finish:()=>location.assign('/')})}}>离开会议</a></div></div>
   </section><aside className="participants-panel"><div className="participants-heading"><h2><Icon kind="people"/>参与者</h2></div><p className="panel-description">每次仅有一人共享屏幕。</p>{room&&<AnnotationRequests room={room} userId={identity.user.id} disabled={busy||!connected||terminal} onAction={(name,target)=>perform(()=>action(name,target))}/>}<ul>{room?.participants.map(p=><li key={p.id}><span className="avatar">{p.name.slice(0,1).toUpperCase()}</span><div><strong>{p.name}{p.id===identity.user.id?'（你）':''}</strong><small>{p.id===room.ownerId?'主持人':p.id===room.publisherId?'共享者':'听众'}</small>{(p.id===room.ownerId||room.annotators?.includes(p.id))&&<small className="annotation-status">可批注</small>}</div>{owner&&p.id!==room.ownerId&&<button className="annotation-permission" disabled={busy||!connected||terminal} aria-label={`${room.annotators?.includes(p.id)?'撤销':'允许'} ${p.name} 批注`} onClick={()=>perform(()=>action(room.annotators?.includes(p.id)?'annotation-revoke':'annotation-grant',p.id))}>{room.annotators?.includes(p.id)?'撤销批注':'允许批注'}</button>}{p.id===room.publisherId&&<span className="publisher-badge" title="当前共享者"><Icon/></span>}</li>)}</ul>{owner&&<div className="transfer"><label htmlFor="publisher">共享者</label><select id="publisher" value={target||room?.publisherId||''} onChange={e=>setTarget(e.target.value)}>{room?.participants.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select><button className="button secondary" disabled={busy||!connected||!(target||room?.publisherId)||terminal} onClick={()=>perform(async()=>{await action('transfer',target||room?.publisherId);setNotice('共享权已转交。新共享者需要主动选择屏幕。')})}>转交共享权</button><p>转交会停止当前共享。主持人可以随时收回共享权。</p></div>}<StreamQuality level={room?.quality??0} stats={stats} active={active}/></aside></div>
   {room?.browserRelayAvailable&&<BrowserRelayPanel overview={relayOverview} maxViewers={room.browserRelayMaxViewers??64} status={relayStatus} enabled={!!room.browserRelayEnabled} owner={owner} disabled={busy||!connected||terminal||room.active} toggle={()=>void perform(()=>action(room.browserRelayEnabled?'browser-relay-off':'browser-relay-on'))}/>}
   {capability&&<p className="compatibility" role="status">{capability}</p>}
   {sharing&&connected&&!terminal&&canPublish&&room?.active&&captured.current&&<PresenterFeedback clockOffset={offset.current} key={room.epoch} stream={captured.current} state={annotations} onStop={()=>{if(roomRef.current?.epoch===room.epoch)void perform(stopSharing)}}/>}
   <div className="meeting-footnote"><span><Icon kind="lock"/>不录制 · 不采集声音 · 不开启摄像头</span><span>登录有效期至 {new Date(identity.expiresAt).toLocaleTimeString()}</span></div>
  </main>}
  <footer className="app-footer"><span>WEBZOOM / 内网协作</span><span data-testid="test-build" title={`基于领导 main · ${testBuild.baseRevision}`}>网页分流试验版 · {testBuild.version}</span></footer>
  {endDialog&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="end-title"><p className="eyebrow">END SESSION</p><h2 id="end-title">结束这场会议？</h2><p>所有参与者将断开连接。此会议链接将失效。</p><div><button className="button secondary" onClick={()=>setEndDialog(false)}>取消</button><button className="button danger" onClick={()=>perform(async()=>{await action('end');setEndDialog(false);setTerminal(true);setNotice('会议已结束。')})}>确认结束</button></div></section></div>}
 </div>;
}
function ScreenIllustration(){return <div className="screen-illustration" aria-hidden="true"><div className="illustration-label"><span className="live-dot"/>一个画面，共同关注</div><div className="illustration-window"><div className="window-bar"><i/><i/><i/><span>DESIGN REVIEW / 01</span></div><div className="illustration-content"><div className="abstract-sidebar"><b/><i/><i/><i/></div><div className="abstract-main"><small>TEAM WORKSPACE</small><strong>Good ideas.<br/>Shared clearly.</strong><div className="abstract-chart"><i/><i/><i/><i/><i/></div></div></div></div><div className="floating-note"><span className="mini-avatar">W</span><div><b>屏幕共享中</b><small>加密连接 · 仅限内网</small></div><Icon/></div></div>}
