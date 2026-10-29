import {useEffect,useState} from 'react';
import type {RelayStatus} from './browserRelay';
import type {BrowserOverview,BrowserParticipant} from './browserRelayProtocol';
import './browser-relay.css';
import {relayDiagnostics} from './relayDiagnostics';
const labels={off:'未开启',publisher:'共享者',root:'网页转发节点',peer:'接收同伴画面',direct:'服务器直连（同伴分流未成功）',waiting:'等待供流'};
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
 if(row.serverBackup)return {label:'画面接收正常 · 正在验证同伴',tone:'success',fresh:true,receiving:true};
 if(row.role==='peer')return {label:'同伴收流正常',tone:'success',fresh:true,receiving:true};
 if(row.role==='direct')return {label:'画面接收正常 · 服务器直连',tone:'success',fresh:true,receiving:true};
 return {label:'服务器供流正常',tone:'success',fresh:true,receiving:true};
}
export default function BrowserRelayPanel({status:s,overview,maxViewers,enabled,owner,disabled,toggle}:{status:RelayStatus;overview?:BrowserOverview|null;maxViewers?:number;enabled:boolean;owner:boolean;disabled:boolean;toggle:()=>void}){
 const [now,setNow]=useState(Date.now),[scope,setScope]=useState<'sharing'|'lifetime'>('sharing'),[diagnostic,setDiagnostic]=useState(''),[copyState,setCopyState]=useState('');
 const localBytes=scope==='sharing'?s.sharing:s;
 const copyDiagnostic=async()=>{const text=relayDiagnostics(s,overview);setDiagnostic(text);try{await navigator.clipboard.writeText(text);setCopyState('已复制（不含账号、地址或登录凭据）')}catch{setCopyState('无法自动复制，请在下方文本框手动复制')}};
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[]);
 const rows=overview?.participants??[],names=new Map(rows.map(row=>[row.user.id,row.user.name]));
 const states=rows.map(row=>overview?reception(row,overview,now):null);
 return <section className="relay-panel" aria-label="网页协作分流" data-testid="relay-panel" data-role={s.role} data-server-backup={!!s.serverBackup} data-center-bytes={s.centerBytes} data-peer-bytes={s.peerBytes} data-sent-bytes={s.sentBytes} data-rejected={s.rejected}>
  <div className="relay-heading"><div><h3>网页协作分流</h3><p>纯网页，无需插件或 EXE · 当前上限 {maxViewers??overview?.maxViewers??64} 位观众 + 1 位共享者</p></div>
  {owner&&<button className="button secondary" disabled={disabled} onClick={toggle}>{enabled?'关闭本会议分流':'开启本会议分流'}</button>}</div>
  <p data-testid="relay-enabled">网页分流：<strong>{enabled?'已开启 · 共享后自动安排':'已关闭'}</strong>{owner&&<small>如需切换，请先停止共享；仅对本会议生效。</small>}</p>
  <p>本机接收：<strong>{!enabled?'网页分流未开启':!s.active?'未在共享':s.role==='publisher'?'正在共享':(s.planFrames??0)>0&&(s.mediaAgeMs??Infinity)<4000?'画面接收正常':'接收状态待确认'}</strong></p>
  <p>画面来源：<strong data-testid="relay-role">{labels[s.role]}</strong> · {s.reason||'开始共享后自动安排转发'}</p>
  {enabled&&<>
   <div className="relay-heading"><label>流量统计范围 <select aria-label="流量统计范围" value={scope} onChange={e=>setScope(e.target.value as 'sharing'|'lifetime')}><option value="sharing">本次共享</option><option value="lifetime">本次页面连接累计</option></select></label><button className="button secondary" onClick={()=>void copyDiagnostic()}>复制诊断信息</button></div>
   {copyState&&<p role="status">{copyState}</p>}
   {diagnostic&&<details><summary>查看脱敏诊断信息</summary><textarea aria-label="脱敏诊断信息" readOnly value={diagnostic} rows={8}/></details>}
   <div className="relay-local" aria-label="本机累计画面流量"><div>本机从服务器接收<strong>{localBytes?mb(localBytes.centerBytes):'—'}</strong></div><div>本机从同伴接收（已验证）<strong>{localBytes?mb(localBytes.peerBytes):'—'}</strong></div><div>本机向同伴发送<strong>{localBytes?mb(localBytes.sentBytes):'—'}</strong></div></div>
   <small>以上为所选范围内的累计画面数据；未提供本次共享统计时显示 —，不会拿历史流量代替。发送量不是对方接收确认，也不是公司出口节省量。{s.path}。</small>
   {owner&&<div className="relay-overview" data-testid="relay-overview">
    <div className="relay-heading"><div><h4>全员接收情况</h4><p>{overview?`在线 ${rows.length} 人（含共享者） · `:""}约每 2 秒更新，不用再找同事拍照。</p></div>{overview&&<span className="relay-capacity">每个转发节点最多带 {overview.maxFanout} 位观众</span>}</div>
    <div className="relay-summary" aria-label="收流汇总"><span>同伴收流正常 <b>{rows.filter((r,i)=>r.role==='peer'&&!r.serverBackup&&states[i]?.receiving).length}</b></span><span>正常服务器供流 <b>{rows.filter((r,i)=>r.role==='root'&&states[i]?.receiving).length}</b></span><span>服务器直连（分流未成功） <b>{rows.filter((r,i)=>r.role==='direct'&&states[i]?.receiving).length}</b></span><span>保留服务器验证同伴 <b>{rows.filter((r,i)=>r.serverBackup&&states[i]?.receiving).length}</b></span><span>待确认 / 等待 <b>{rows.filter((r,i)=>r.role!=='publisher'&&!states[i]?.receiving).length}</b></span></div>
    {!overview?<p role="status">正在等待全员接收报告…</p>:<div className="relay-table-scroll"><table className="relay-table"><caption className="relay-sr-only">本会议在线成员的画面来源与接收端上报</caption><thead><tr><th scope="col">成员 / 画面来源</th><th scope="col">当前状态</th><th scope="col">从服务器接收</th><th scope="col">从同伴接收（已验证）</th><th scope="col">向同伴发送</th></tr></thead><tbody>{rows.map((row,i)=>{
     const state=states[i]!,report=row.report,traffic=scope==='sharing'?report?.sharing:report;
     const rate=(bps:number|undefined)=>state.fresh&&bps!==undefined&&Number.isFinite(bps)?<small>近 {((row.rates?.sampleMs??0)/1000).toFixed(1)} 秒：{(bps/1000000).toFixed(2)} Mbps</small>:null;
     const source=row.serverBackup?'服务器继续供流 · 同伴验证中':row.role==='peer'?`同伴：${names.get(row.parent)??'正在安排'}`:row.role==='root'?`服务器 · 已安排向 ${row.children} 人转发`:row.role==='direct'?'服务器直连（回退）':row.role==='publisher'?'上传共享画面':row.role==='waiting'?'尚无可用供流':'尚未共享';
     return <tr key={row.user.id} data-testid="relay-member" data-member-id={row.user.id} data-role={row.role} data-receiving={state.receiving} data-peer-bytes={report?.peerBytes??''} data-center-bytes={report?.centerBytes??''}>
      <th scope="row"><strong>{row.user.name}</strong><small>{source}</small></th><td><span className={`relay-badge ${state.tone}`}>{state.label}</span><small>{row.reason}</small>{report?.visibility==='hidden'&&<small>{state.fresh?'页面在后台（不等于断流）':'上次上报时页面在后台，当前状态未知'}</small>}{report&&<small>{state.fresh?'接收端已上报':'报告缺失或过期'} · 本次安排已验证 {report.planFrames} 帧</small>}</td>
      <td>{traffic?mb(traffic.centerBytes):'—'}{rate(row.rates?.centerBps)}</td><td>{traffic?mb(traffic.peerBytes):'—'}{rate(row.rates?.peerBps)}</td><td>{traffic?mb(traffic.sentBytes):'—'}{rate(row.rates?.sentBps)}</td>
     </tr>;
    })}</tbody></table></div>}
    <small className="relay-table-hint">表格可向下滚动查看全部成员；窄屏可左右滑动查看流量。</small>
    <small>接收量由各观众已登录的网页自行上报，只展示本会议在线成员。MB 按所选范围统计；Mbps 是相邻上报的平均速率，非即时网卡测量，不能相加当作公司节流量；上报超过 8 秒未更新会标记待确认，不能保证画面已显示在屏幕上。</small>
   </div>}
   <small>人数增加后自动安排多个转发节点，尽量保留已有连接；同伴失败时有限尝试其他可用节点；回退后至少间隔 30 秒，只对未失败且近期供流正常的节点最多追加验证两次，验证期间保留服务器供流。不保证同一办公室分组。回退仍受服务器额度限制。仅在获准互联的网络使用。此上限不是已实测容量。</small>
  </>}
 </section>;
}
