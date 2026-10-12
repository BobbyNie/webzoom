import {useEffect,useState} from 'react';
import {APIError,request} from './api';
import {keepSessionAlive} from './session';
import type {Identity} from './types';
import {trafficRate,type Overview} from './adminMetrics';
import './admin.css';

type Sample={current:Overview;previous?:Overview};
const bytes=(n:number)=>`${(n/1000000).toFixed(2)} MB`;
const date=(s:string)=>new Date(s).toLocaleString();

export default function Admin(){
 const [sample,setSample]=useState<Sample>();
 const [status,setStatus]=useState('正在加载总览…');
 const [login,setLogin]=useState(false);
 const [notice,setNotice]=useState('');
 useEffect(()=>{
  let disposed=false,blocked=false,previous:Overview|undefined,identity:Identity;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let stopSession=()=>{};
  let controller=new AbortController();
  async function read<T>(path:string):Promise<T>{
   controller=new AbortController();
   const timeout=setTimeout(()=>controller.abort(),15000);
   try{return await request<T>(path,undefined,undefined,controller.signal)}
   finally{clearTimeout(timeout)}
  }
  const deny=(expired:boolean)=>{
   blocked=true;previous=undefined;setSample(undefined);setLogin(expired);
   setStatus(expired?'登录已失效，请重新登录。':'没有管理员权限。请联系部署维护人员。');
   stopSession();
  };
  async function poll(){
   if(disposed||blocked)return;
   try{
    const current=await read<Overview>('/api/admin/overview');
    if(disposed||blocked)return;
    setSample({current,previous:previous?.instanceId===current.instanceId?previous:undefined});
    previous=current;setStatus('');
   }catch(error){
    if(disposed||blocked)return;
    previous=undefined;setSample(undefined);
    if(error instanceof APIError&&(error.status===401||error.status===403)){deny(error.status===401);return}
    setStatus('无法更新总览。请检查网络或刷新页面。');
   }
   if(!disposed&&!blocked)timer=setTimeout(()=>void poll(),5000);
  }
  async function start(){
   try{
    identity=await read<Identity>('/api/me');
    if(disposed)return;
    stopSession=keepSessionAlive({expiresAt:identity.expiresAt,
     active:()=>document.visibilityState==='visible',
     renew:signal=>request<Identity>('/auth/refresh',identity.csrf,{},signal),
     inspect:signal=>request<Identity>('/api/me',undefined,undefined,signal),
     onRenewed:next=>{identity=next},onExpired:()=>deny(true),
     onUnavailable:()=>setNotice('会话续期暂时失败。正在重试。'),onRecovered:()=>setNotice('')});
    await poll();
   }catch(error){
    if(disposed)return;
    if(error instanceof APIError&&error.status===401)deny(true);
    else setStatus('无法检查登录状态。请刷新页面重试。');
   }
  }
  void start();
  return ()=>{disposed=true;controller.abort();clearTimeout(timer);stopSession()};
 },[]);
 const current=sample?.current,previous=sample?.previous;
 const elapsed=current&&previous?Date.parse(current.sampledAt)-Date.parse(previous.sampledAt):0;
 const rate=(key:'ingressBytes'|'egressBytes')=>current?trafficRate(previous?.[key],current[key],elapsed):'等待采样';
 return <div className="admin-shell">
  <header className="admin-header"><a href="/">WebZoom</a><span>只读管理页面</span><a href="/">返回会议首页</a></header>
  <main className="admin-main">
   <h1>管理员总览</h1>
   <p className="admin-description">每 5 秒更新。此页面不改变会议状态，也不设置会议或人数限制。</p>
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
    <section aria-label="会议明细"><h2>会议明细</h2>
     {!current.rooms.length?<p className="admin-message">当前没有有效会议。</p>:<div className="admin-table-wrap"><table><thead><tr><th>会议 ID</th><th>状态</th><th>参与人数</th><th>入口速率 / 累计</th><th>出口速率 / 累计</th><th>创建 / 到期时间</th></tr></thead><tbody>
      {current.rooms.map(room=>{const before=previous?.rooms.find(r=>r.id===room.id);return <tr key={room.id}>
       <td><code>{room.id}</code></td><td>{room.active?'正在共享':'未共享'}</td><td>{room.participants}</td>
       <td>{trafficRate(before?.ingressBytes,room.ingressBytes,elapsed)}<br/>{bytes(room.ingressBytes)}</td>
       <td>{trafficRate(before?.egressBytes,room.egressBytes,elapsed)}<br/>{bytes(room.egressBytes)}</td>
       <td>{date(room.createdAt)}<br/>{date(room.expiresAt)}</td>
      </tr>})}
     </tbody></table></div>}
    </section>
    <footer className="admin-description"><p>采样时间：{date(current.sampledAt)} · 服务启动：{date(current.startedAt)}</p>
     <p>速率为相邻采样之间的平均值。首次采样或服务重启后显示“等待采样”。</p>
     <p>仅统计已接受和已成功发送的屏幕二进制消息，包含应用帧头。不包含 HTTP、控制消息、TLS 或 WebSocket 协议开销。</p>
     <p>服务累计流量包含已结束会议，重启后归零。每场会议的累计流量从创建开始计算。MB = 1,000,000 字节。</p>
    </footer>
   </>}
  </main>
 </div>;
}
