import {useEffect,useRef,useState} from 'react';
import {endSelectedRooms,type EndResponse,type EndReport} from './adminBatch';
import {trafficRate,type Overview} from './adminMetrics';
interface Props {
 current?:Overview;previous?:Overview;
 endRooms:(ids:string[],signal:AbortSignal)=>Promise<EndResponse>;
 onEnded:(ids:string[])=>void;
}
const bytes=(n:number)=>`${(n/1000000).toFixed(2)} MB`;
const date=(s:string)=>new Date(s).toLocaleString();
export default function AdminMeetings({current,previous,endRooms,onEnded}:Props){
 const [selected,setSelected]=useState<string[]>([]);
 const [confirmation,setConfirmation]=useState<string[]>();
 const [busy,setBusy]=useState(false);
 const [report,setReport]=useState<EndReport>();
 const [selectionNotice,setSelectionNotice]=useState('');
 const instance=useRef(current?.instanceId);
 const dialog=useRef<HTMLDialogElement>(null),controller=useRef<AbortController|undefined>(undefined);
 const mounted=useRef(true),submitting=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;controller.current?.abort()}},[]);
 useEffect(()=>{
  const restarted=!!current&&instance.current!==current.instanceId;
  if(restarted)controller.current?.abort();
  instance.current=current?.instanceId;
  const live=new Set(current?.rooms.map(r=>r.id));
  setSelected(ids=>restarted?[]:ids.filter(id=>live.has(id)));
  if(!busy&&confirmation&&(restarted||confirmation.some(id=>!live.has(id)))){
   setConfirmation(undefined);setSelectionNotice('会议列表已改变。请检查选择并重新确认。');
  }
 },[current,busy,confirmation]);
 useEffect(()=>{
  if(confirmation&&!dialog.current?.open)dialog.current?.showModal();
  else if(!confirmation&&dialog.current?.open)dialog.current.close();
 },[confirmation]);
 async function end(){
  if(!confirmation||submitting.current)return;
  submitting.current=true;setBusy(true);setReport(undefined);setSelectionNotice('');
  const operation=new AbortController();controller.current=operation;
  const result=await endSelectedRooms(confirmation,async ids=>{
   if(!mounted.current||operation.signal.aborted)throw new Error('termination cancelled');
   const timeout=setTimeout(()=>operation.abort(),15000);
   try{return await endRooms(ids,operation.signal)}finally{clearTimeout(timeout)}
  });
  if(!mounted.current)return;
  const resolved=[...result.ended,...result.notFound];
  setReport(result);setSelected(ids=>ids.filter(id=>!resolved.includes(id)));
  setConfirmation(undefined);setBusy(false);submitting.current=false;onEnded(resolved);
 }
 const selectedSet=new Set(selected);
 const elapsed=current&&previous?Date.parse(current.sampledAt)-Date.parse(previous.sampledAt):0;
 return <section aria-label="会议明细"><h2>会议明细</h2>
  {selectionNotice&&<p role="status">{selectionNotice}</p>}
  {report&&<div className="admin-results" role={report.error?'alert':'status'}>
   <p>已结束 {report.ended.length} 场；已结束或已过期 {report.notFound.length} 场；结果未确认 {report.unconfirmed.length} 场。</p>
   {report.error!==undefined&&<p>请求失败或超时。部分结果未确认。请刷新总览，检查剩余会议后重试。</p>}
   <details><summary>查看逐项结果</summary><ul>
    {report.ended.map(id=><li key={id}><code>{id}</code>：已结束</li>)}
    {report.notFound.map(id=><li key={id}><code>{id}</code>：已结束或已过期</li>)}
    {report.unconfirmed.map(id=><li key={id}><code>{id}</code>：结果未确认</li>)}
   </ul></details>
  </div>}
  {current&&<>
   <div className="admin-selection"><label><input type="checkbox" aria-label="全选当前会议" disabled={busy||!current.rooms.length} checked={!!current.rooms.length&&selected.length===current.rooms.length} onChange={e=>setSelected(e.target.checked?current.rooms.map(r=>r.id):[])}/> 全选当前会议</label>
    <span>已选择 {selected.length} 场会议。</span>
    <button className="button danger" disabled={busy||!selected.length} onClick={()=>setConfirmation([...selected])}>批量结束会议</button>
   </div>
   {!current.rooms.length?<p className="admin-message">当前没有有效会议。</p>:<div className="admin-table-wrap"><table><thead><tr><th>选择</th><th>会议 ID</th><th>状态</th><th>参与人数</th><th>入口速率 / 累计</th><th>出口速率 / 累计</th><th>创建 / 到期时间</th></tr></thead><tbody>
    {current.rooms.map(room=>{const before=previous?.rooms.find(r=>r.id===room.id);return <tr key={room.id}>
     <td><input type="checkbox" aria-label={`选择会议 ${room.id}`} disabled={busy} checked={selectedSet.has(room.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,room.id]:ids.filter(id=>id!==room.id))}/></td>
     <td><code>{room.id}</code></td><td>{room.active?'正在共享':'未共享'}</td><td>{room.participants}</td>
     <td>{trafficRate(before?.ingressBytes,room.ingressBytes,elapsed)}<br/>{bytes(room.ingressBytes)}</td>
     <td>{trafficRate(before?.egressBytes,room.egressBytes,elapsed)}<br/>{bytes(room.egressBytes)}</td>
     <td>{date(room.createdAt)}<br/>{date(room.expiresAt)}</td>
    </tr>})}
   </tbody></table></div>}
  </>}
  <dialog ref={dialog} className="modal admin-end-dialog" aria-labelledby="admin-end-title" onCancel={e=>{if(busy)e.preventDefault();else setConfirmation(undefined)}}>
   <h2 id="admin-end-title">结束选定的 {confirmation?.length??0} 场会议？</h2>
   <p>所有参与者将断开连接。原会议链接将失效。此操作不能撤销。</p>
   <ul>{confirmation?.map(id=><li key={id}><code>{id}</code></li>)}</ul>
   <div><button className="button secondary" disabled={busy} onClick={()=>setConfirmation(undefined)}>取消</button>
    <button className="button danger" disabled={busy} onClick={()=>void end()}>{busy?'正在结束…':'确认结束选定会议'}</button></div>
  </dialog>
 </section>;
}
