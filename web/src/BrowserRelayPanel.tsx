import {useEffect,useState} from 'react';
import type {RelayStatus} from './browserRelay';
import type {BrowserOverview,BrowserParticipant} from './browserRelayProtocol';
import './browser-relay.css';
const labels={off:'未开启',publisher:'共享者',root:'网页转发节点',peer:'接收同伴画面',direct:'服务器直连回退',waiting:'等待供流'};
const mb=(value:number)=>`${(value/1048576).toFixed(2)} MB`;
export function reception(row:BrowserParticipant,overview:BrowserOverview,now:number){
 if(!overview.active)return {label:'未在共享',tone:'neutral',fresh:false,receiving:false};
 const age=row.report?Math.max(0,overview.generatedAt-row.reportedAt)+Math.max(0,now-(overview.receivedAt??now)):Infinity;
 if(!row.report)return {label:'等待接收端上报',tone:'neutral',fresh:false,receiving:false};
 if(age>8000)return {label:'上报中断，状态待确认',tone:'warning',fresh:false,receiving:false};
 if(row.role==='publisher')return {label:'共享者',tone:'neutral',fresh:true,receiving:false};
 if(row.role==='waiting')return {label:'等待供流',tone:'warning',fresh:true,receiving:false};
 const receiving=row.report.planFrames>0&&row.report.mediaAgeMs+age<4000;
 if(!receiving)return {label:'画面暂未更新',tone:'warning',fresh:true,receiving:false};
 if(row.role==='peer')return {label:'同伴收流正常',tone:'success',fresh:true,receiving:true};
 if(row.role==='direct')return {label:'已回退服务器',tone:'warning',fresh:true,receiving:true};
 return {label:'服务器供流正常',tone:'success',fresh:true,receiving:true};
}
export default function BrowserRelayPanel({status:s,overview,maxViewers=32,enabled,owner,disabled,toggle}:{status:RelayStatus;overview?:BrowserOverview|null;maxViewers?:number;enabled:boolean;owner:boolean;disabled:boolean;toggle:()=>void}){
 const [now,setNow]=useState(Date.now);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[]);
 const rows=overview?.participants??[],names=new Map(rows.map(row=>[row.user.id,row.user.name]));
 const states=rows.map(row=>overview?reception(row,overview,now):null);
 return <section className="relay-panel" aria-label="网页协作分流试验" data-testid="relay-panel" data-role={s.role} data-center-bytes={s.centerBytes} data-peer-bytes={s.peerBytes} data-sent-bytes={s.sentBytes} data-rejected={s.rejected}>
  <div className="relay-heading"><div><h3>网页协作分流</h3><p>纯网页，无需插件或 EXE · 当前上限 {maxViewers} 位观众 + 1 位共享者</p></div>
  {owner&&<button className="button secondary" disabled={disabled} onClick={toggle}>{enabled?'关闭网页分流试验':'开启网页分流试验'}</button>}</div>
  <p>本机状态：<strong data-testid="relay-role">{labels[s.role]}</strong> · {s.reason||'开始共享后自动安排转发'}</p>
  {enabled&&<>
   <div className="relay-local" aria-label="本机累计画面流量"><div>本机从服务器接收<strong>{mb(s.centerBytes)}</strong></div><div>本机从同伴接收（已验证）<strong>{mb(s.peerBytes)}</strong></div><div>本机向同伴发送<strong>{mb(s.sentBytes)}</strong></div></div>
   <small>以上只统计本机这次页面连接的累计画面数据；发送量不是对方接收确认，也不是公司出口节省量。{s.path}。</small>
   {owner&&<div className="relay-overview" data-testid="relay-overview">
    <div className="relay-heading"><div><h4>全员接收情况</h4><p>{overview?`在线 ${rows.length} 人（含共享者） · `:""}约每 2 秒更新，不用再找同事拍照。</p></div>{overview&&<span className="relay-capacity">每个转发节点最多带 {overview.maxFanout} 位观众</span>}</div>
    <div className="relay-summary" aria-label="收流汇总"><span>同伴收流正常 <b>{rows.filter((r,i)=>r.role==='peer'&&states[i]?.receiving).length}</b></span><span>服务器供流 / 回退 <b>{rows.filter((r,i)=>(r.role==='root'||r.role==='direct')&&states[i]?.receiving).length}</b></span><span>待确认 / 等待 <b>{rows.filter((r,i)=>r.role!=='publisher'&&!states[i]?.receiving).length}</b></span></div>
    {!overview?<p role="status">正在等待全员接收报告…</p>:<div className="relay-table-scroll"><table className="relay-table"><caption className="relay-sr-only">本会议在线成员的画面来源与接收端上报</caption><thead><tr><th scope="col">成员 / 画面来源</th><th scope="col">当前状态</th><th scope="col">从服务器接收</th><th scope="col">从同伴接收（已验证）</th><th scope="col">向同伴发送</th></tr></thead><tbody>{rows.map((row,i)=>{
     const state=states[i]!,report=row.report;
     const source=row.role==='peer'?`同伴：${names.get(row.parent)??'正在安排'}`:row.role==='root'?`服务器 · 已安排向 ${row.children} 人转发`:row.role==='direct'?'服务器直连（回退）':row.role==='publisher'?'上传共享画面':row.role==='waiting'?'尚无可用供流':'尚未共享';
     return <tr key={row.user.id} data-testid="relay-member" data-member-id={row.user.id} data-role={row.role} data-receiving={state.receiving} data-peer-bytes={report?.peerBytes??''} data-center-bytes={report?.centerBytes??''}>
      <th scope="row"><strong>{row.user.name}</strong><small>{source}</small></th><td><span className={`relay-badge ${state.tone}`}>{state.label}</span><small>{row.reason}</small>{report&&<small>{state.fresh?'接收端已上报':'报告缺失或过期'} · 本次安排已验证 {report.planFrames} 帧</small>}</td>
      <td>{report?mb(report.centerBytes):'—'}</td><td>{report?mb(report.peerBytes):'—'}</td><td>{report?mb(report.sentBytes):'—'}</td>
     </tr>;
    })}</tbody></table></div>}
    <small className="relay-table-hint">表格可向下滚动查看全部成员；窄屏可左右滑动查看流量。</small>
    <small>接收量由各观众已登录的网页自行上报，只展示本会议在线成员。数字按各自页面连接累计，不能相加当作公司节流量；上报超过 8 秒未更新会标记待确认，不能保证画面已显示在屏幕上。</small>
   </div>}
   <small>人数增加后自动安排多个转发节点，但不保证同一办公室分组；连接失败时仍需服务器额度允许才能回退。仅在获准互联的网络使用。此上限不是已实测容量。</small>
  </>}
 </section>;
}
