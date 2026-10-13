import {useEffect,useRef,useState} from 'react';
import {APIError,request} from './api';
import {keepSessionAlive} from './session';
import type {Identity} from './types';
import {trafficRate,type BandwidthStatus,type Overview} from './adminMetrics';
import AdminMeetings from './AdminMeetings';
import AdminBandwidth from './AdminBandwidth';
import type {EndResponse} from './adminBatch';
import './admin.css';

type Sample={current:Overview;previous?:Overview};
const bytes=(n:number)=>`${(n/1000000).toFixed(2)} MB`;
const date=(s:string)=>new Date(s).toLocaleString();

export default function Admin(){
 const [sample,setSample]=useState<Sample>();
 const [status,setStatus]=useState('正在加载总览…');
 const [login,setLogin]=useState(false);
 const [notice,setNotice]=useState('');
 const [authorized,setAuthorized]=useState(false);
 const identityRef=useRef<Identity|undefined>(undefined);
 const denyRef=useRef<(expired:boolean)=>void>(()=>{});
 const refreshRef=useRef<()=>void>(()=>{});
 useEffect(()=>{
  let disposed=false,blocked=false,previous:Overview|undefined,identity:Identity,pollVersion=0;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let stopSession=()=>{};
  let controller=new AbortController();
  async function read<T>(path:string):Promise<T>{
   const operation=new AbortController();controller=operation;
   const timeout=setTimeout(()=>operation.abort(),15000);
   try{return await request<T>(path,undefined,undefined,operation.signal)}
   finally{clearTimeout(timeout)}
  }
  const deny=(expired:boolean)=>{
   blocked=true;identityRef.current=undefined;previous=undefined;setSample(undefined);setLogin(expired);setAuthorized(false);
   setStatus(expired?'登录已失效，请重新登录。':'没有管理员权限。请联系部署维护人员。');
   stopSession();
  };
  denyRef.current=deny;
  async function poll(){
   if(disposed||blocked)return;
   const version=++pollVersion;controller.abort();clearTimeout(timer);
   try{
    const current=await read<Overview>('/api/admin/overview');
    if(disposed||blocked||version!==pollVersion)return;
    setAuthorized(true);
    setSample({current,previous:previous?.instanceId===current.instanceId?previous:undefined});
    previous=current;setStatus('');
   }catch(error){
    if(disposed||blocked||version!==pollVersion)return;
    previous=undefined;setSample(undefined);
    if(error instanceof APIError&&(error.status===401||error.status===403)){deny(error.status===401);return}
    setStatus('无法更新总览。请检查网络或刷新页面。');
   }
   if(!disposed&&!blocked&&version===pollVersion)timer=setTimeout(()=>void poll(),5000);
  }
  refreshRef.current=()=>void poll();
  async function start(){
   try{
    identity=await read<Identity>('/api/me');
    if(disposed)return;
    identityRef.current=identity;
    stopSession=keepSessionAlive({expiresAt:identity.expiresAt,
     active:()=>document.visibilityState==='visible',
     renew:signal=>request<Identity>('/auth/refresh',identity.csrf,{},signal),
     inspect:signal=>request<Identity>('/api/me',undefined,undefined,signal),
     onRenewed:next=>{identity=next;identityRef.current=next},onExpired:()=>deny(true),
     onUnavailable:()=>setNotice('会话续期暂时失败。正在重试。'),onRecovered:()=>setNotice('')});
    await poll();
   }catch(error){
    if(disposed)return;
    if(error instanceof APIError&&error.status===401)deny(true);
    else setStatus('无法检查登录状态。请刷新页面重试。');
   }
  }
  void start();
  return ()=>{disposed=true;identityRef.current=undefined;controller.abort();clearTimeout(timer);stopSession()};
 },[]);
 const current=sample?.current,previous=sample?.previous;
 const elapsed=current&&previous?Date.parse(current.sampledAt)-Date.parse(previous.sampledAt):0;
 const rate=(key:'ingressBytes'|'egressBytes')=>current?trafficRate(previous?.[key],current[key],elapsed):'等待采样';
 return <div className="admin-shell">
  <header className="admin-header"><a href="/">WebZoom</a><span>管理员页面</span><a href="/">返回会议首页</a></header>
  <main className="admin-main">
   <h1>管理员总览</h1>
   <p className="admin-description">每 5 秒更新。管理员可以结束选定会议。管理员可以设置总流量接入上限。会议数量和人数仍不受固定限制。</p>
   {status&&<p role="alert" className="admin-message">{status}</p>}
   {notice&&<p role="status" className="admin-message">{notice}</p>}
   {login&&<a className="button primary" href="/auth/login?next=%2Fadmin">使用 SSO 登录</a>}
   {current&&<>
    <section aria-label="服务总览" className="admin-cards">
     <article><h2>有效会议</h2><strong data-testid="room-count">{current.rooms.length}</strong><p>包含暂时无人参加的未过期会议</p></article>
     <article><h2>已连接参与人数</h2><strong>{current.rooms.reduce((sum,r)=>sum+r.participants,0)}</strong><p>包含共享者；同一人跨会议分别计数</p></article>
     <article><h2>媒体入口</h2><strong>{rate('ingressBytes')}</strong><p>累计 {bytes(current.ingressBytes)}</p></article>
     <article><h2>媒体出口</h2><strong data-testid="egress-rate">{rate('egressBytes')}</strong><p>累计 {bytes(current.egressBytes)}</p></article>
    </section>

   </>}
   {authorized&&<AdminBandwidth current={current} save={async(limit,signal)=>{
    try{
     if(!identityRef.current)throw new APIError(401,'authentication required');
     return await request<BandwidthStatus>('/api/admin/bandwidth',identityRef.current.csrf,{limitMbps:limit},signal);
    }catch(error){
     if(error instanceof APIError&&(error.status===401||error.status===403))denyRef.current(error.status===401);
     throw error;
    }
   }} onSaved={bandwidth=>{
    setSample(s=>s?{...s,current:{...s.current,bandwidth}}:s);
    refreshRef.current();
   }}/>}
   {authorized&&<AdminMeetings current={current} previous={previous} endRooms={async(ids,signal)=>{
    try{
     if(!identityRef.current)throw new APIError(401,'authentication required');
     return await request<EndResponse>('/api/admin/rooms/end',identityRef.current.csrf,{roomIds:ids},signal);
    }catch(error){
     if(error instanceof APIError&&(error.status===401||error.status===403))denyRef.current(error.status===401);
     throw error;
    }
   }} onEnded={ids=>{
    setSample(s=>s?{current:{...s.current,rooms:s.current.rooms.filter(r=>!ids.includes(r.id))}}:s);
    refreshRef.current();
   }}/>}
   {current&&<footer className="admin-description"><p>采样时间：{date(current.sampledAt)} · 服务启动：{date(current.startedAt)}</p>
     <p>速率为相邻采样之间的平均值。首次采样或服务重启后显示“等待采样”。</p>
     <p>仅统计已接受和已成功发送的屏幕二进制消息，包含应用帧头。不包含 HTTP、控制消息、TLS 或 WebSocket 协议开销。</p>
     <p>服务累计流量包含已结束会议，重启后归零。每场会议的累计流量从创建开始计算。MB = 1,000,000 字节。</p>
    </footer>}
  </main>
 </div>;
}
