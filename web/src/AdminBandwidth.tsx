import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {BandwidthStatus,Overview} from './adminMetrics';

type Props={current?:Overview;save:(limit:number,signal:AbortSignal)=>Promise<BandwidthStatus>;onSaved:(status:BandwidthStatus)=>void};
export default function AdminBandwidth({current,save,onSaved}:Props){
 const [value,setValue]=useState(String(current?.bandwidth?.limitMbps??200));
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const dirty=useRef(false),instance=useRef(current?.instanceId),operation=useRef<AbortController|undefined>(undefined);
 const status=current?.bandwidth;
 useEffect(()=>{
  if(!current)return;
  const restarted=instance.current!==current.instanceId;instance.current=current.instanceId;
  if(restarted){operation.current?.abort();operation.current=undefined;dirty.current=false;setBusy(false);setError('');setNotice('')}
  if((restarted||!dirty.current)&&current.bandwidth)setValue(String(current.bandwidth.limitMbps));
 },[current]);
 useEffect(()=>()=>operation.current?.abort(),[]);
 async function submit(event:FormEvent){
  event.preventDefault();if(operation.current||!status)return;
  const limit=Number(value);setNotice('');setError('');
  if(!value.trim()||!Number.isInteger(limit)||limit<1||limit>1000000){setError('请输入 1 至 1000000 的整数，单位为 Mbps。');return}
  const controller=new AbortController();operation.current=controller;setBusy(true);
  const timeout=setTimeout(()=>controller.abort(),15000);
  try{
   const saved=await save(limit,controller.signal);
   if(controller.signal.aborted||operation.current!==controller)return;
   dirty.current=false;setValue(String(saved.limitMbps));onSaved(saved);
   setNotice('已保存，立即生效。服务重启后保留此设置。');
  }catch{
   if(operation.current===controller)setError('无法确认保存结果。请检查持久存储与网络，再刷新页面确认。');
  }finally{
   clearTimeout(timeout);if(operation.current===controller){operation.current=undefined;setBusy(false)}
  }
 }
 return <section className="admin-bandwidth" aria-label="总流量接入限制">
  <h2>总流量接入限制</h2>
  <div className="bandwidth-summary"><p>总媒体流量 <strong data-testid="total-bandwidth-rate">{status?`${status.totalMbps.toFixed(2)} Mbps`:'无法获取当前流量'}</strong></p>
   <p>当前上限 <strong>{status?`${status.limitMbps} Mbps`:'等待更新'}</strong></p>
   <p className={status?.blocked?'bandwidth-blocked':''}>{status?(status.blocked?'暂停新建会议和新连接':'允许接入'):'接入状态待确认'}</p>
  </div>
  <form onSubmit={event=>void submit(event)} noValidate>
   <label htmlFor="bandwidth-limit">总流量上限（Mbps）</label>
   <div className="bandwidth-form"><input id="bandwidth-limit" type="number" min="1" max="1000000" step="1" required value={value} disabled={busy} onChange={event=>{dirty.current=true;setValue(event.target.value);setNotice('');setError('')}}/>
    <button className="button primary" type="submit" disabled={busy||!status}>{busy?'正在保存…':'保存上限'}</button></div>
  </form>
  {error&&<p role="alert" className="admin-results">{error}</p>}
  {notice&&<p role="status" className="admin-results">{notice}</p>}
  <p className="admin-description">按最近 5 秒的媒体入口与出口之和判断，窗口精度为 100 毫秒。只有超过上限才暂停接入。已有连接不受影响，流量回落后自动恢复接入。</p>
  <p className="admin-description">设置保存到服务器配置文件。持久存储不可用时，服务器不会应用新的上限。此功能不对已有连接强制限速。</p>
 </section>;
}
