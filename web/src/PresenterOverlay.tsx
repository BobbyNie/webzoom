import {useEffect,useState} from 'react';
import {APIError,request} from './api';
import './presenter-overlay.css';

type Pairing={pairing:string;expiresAt:string};
type Props={roomID:string;epoch:number;csrf:string;track:MediaStreamTrack|null};
export default function PresenterOverlay({roomID,epoch,csrf,track}:Props){
 const [pairing,setPairing]=useState<Pairing|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[now,setNow]=useState(Date.now());
 const surface=(track?.getSettings() as (MediaTrackSettings&{displaySurface?:string})|undefined)?.displaySurface;
 const available=surface==='monitor';
 useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id)},[]);
 useEffect(()=>{setPairing(null);setMessage('');setError('')},[epoch,track]);
 const expires=pairing?Math.max(0,Math.ceil((Date.parse(pairing.expiresAt)-now)/1000)):0;
 async function generate(){
  setBusy(true);setError('');setPairing(null);setMessage('');
  try{
   const settings=track?.getSettings() as MediaTrackSettings&{displaySurface?:string};
   if(track?.readyState!=='live'||settings?.displaySurface!=='monitor')throw new Error('请先共享整块显示器。');
   const next=await request<Pairing>(`/api/rooms/${encodeURIComponent(roomID)}/overlay`,csrf,{epoch,surface:settings.displaySurface,width:settings.width,height:settings.height});
   if(track.readyState!=='live')return;
   setNow(Date.now());setPairing(next);setMessage('配对信息已生成；这不代表助手已连接。请粘贴到 Windows 助手中。');
  }catch(e){setError(e instanceof APIError&&e.status===401?'登录已失效，请重新登录。':(e as Error).message)}finally{setBusy(false)}
 }
 async function disconnect(){
  setBusy(true);setError('');
  try{
   const response=await fetch(`/api/rooms/${encodeURIComponent(roomID)}/overlay`,{method:'DELETE',credentials:'same-origin',headers:{'X-CSRF-Token':csrf}});
   if(!response.ok)throw new Error('未能断开助手，请使用助手退出快捷键，或停止共享。');
   setPairing(null);setMessage('已撤销配对信息并断开本次会话的助手。');
  }catch(e){setError((e as Error).message)}finally{setBusy(false)}
 }
 async function copy(){try{if(!pairing||!expires)return;await navigator.clipboard.writeText(pairing.pairing);setMessage('已复制。请只粘贴到你自己的 Windows 助手，不要发给参会人。')}catch{setError('复制失败，请检查浏览器的剪贴板权限后重试。为避免整屏共享泄露配对信息，这里不会明文显示。')}}
 return <section className="presenter-overlay" aria-label="原屏幕批注助手">
  <h3>在原屏幕上看批注 <span>Windows · 实验版</span></h3>
  <p>无需切回 WebZoom。共享者运行免安装助手，参会人仍用网页。本版只支持共享整块显示器，不支持单独窗口或标签页。</p>
  {!available?<p className="overlay-warning">当前不是整屏共享，或浏览器无法确认共享类型。请停止共享，重新选择“整个屏幕”后再配对。</p>:<>
   <p>先从维护人员获取 WebZoomOverlay.exe，以普通用户运行，选择与你共享的同一块显示器，再粘贴配对信息。不要以管理员身份运行。</p>
   <button className="button secondary" disabled={busy} onClick={()=>void generate()}>生成助手配对信息</button>
  </>}
  <button className="button secondary" disabled={busy} onClick={()=>void disconnect()}>断开批注助手</button>
  {pairing&&expires>0&&<div className="overlay-pairing"><label htmlFor="overlay-pairing-text">一次性配对信息（剩余 {expires} 秒，请勿外传）</label><input id="overlay-pairing-text" type="password" readOnly value={pairing.pairing} autoComplete="off" spellCheck={false}/><button className="button secondary" onClick={()=>void copy()}>复制配对信息</button></div>}
  {pairing&&expires===0&&<p>配对信息已过期；若助手已经连接则不受影响。需要连接时请重新生成。</p>}
  {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
  <small>停止共享会断开助手。Ctrl+Alt+Shift+F8 隐藏/显示反馈；Ctrl+Alt+Shift+F9 退出助手。批注按屏幕位置显示，不会跟随滚动后的按钮或段落。</small>
 </section>;
}
