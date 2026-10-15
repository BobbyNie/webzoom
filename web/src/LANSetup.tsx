import {useEffect,useState} from 'react';
import {request} from './api';
import {checkLANInstallation,type LocalCheck} from './lan-setup';
import {lanErrorText} from './lan-errors';
type Info={enabled:boolean;available:boolean;origin:string;port:number;sha256?:string;reason?:string};
export default function LANSetup({enabled,status,sharing,onMode}:{enabled:boolean;status:string;sharing:boolean;onMode:(enabled:boolean)=>void}){
 const [info,setInfo]=useState<Info|null>(null),[error,setError]=useState(''),[check,setCheck]=useState<LocalCheck|null>(null),[checking,setChecking]=useState(false),[downloaded,setDownloaded]=useState(false);
 useEffect(()=>{let alive=true;request<Info>('/api/lan/client').then(v=>{if(alive)setInfo(v)}).catch(()=>{if(alive)setError('暂时无法读取安装信息，请刷新页面；若仍失败，请联系维护人员确认服务端已更新。')});return()=>{alive=false}},[]);
 useEffect(()=>{if(!info?.enabled||enabled)return;let alive=true;setChecking(true);void checkLANInstallation(info?.port??0).then(v=>{if(alive){setCheck(v);setChecking(false)}});return()=>{alive=false}},[info,enabled]);
 async function recheck(){setChecking(true);setCheck(await checkLANInstallation(info?.port??0));setChecking(false)}
 if(!info)return <section className="lan-panel" aria-label="局域网分流"><p role="status">{error||'正在读取局域网客户端安装信息…'}</p></section>;
 if(!info.enabled)return <section className="lan-panel" aria-label="局域网分流"><h2>局域网分流</h2><p>管理员尚未开启此功能，普通共享无需安装客户端。</p></section>;
 const ready=check?.ok===true;
 return <section className="lan-panel" aria-label="局域网分流">
  <h2>局域网分流 · 安装与检查</h2>
  <p>首次使用：从本内网页面下载并安装一次。不需要同事访问 GitHub，也不用你逐个发送文件。</p>
  <p role="status">{enabled?status:checking?'正在自动检查本机插件和辅助程序…':ready?'本机安装检查通过。多人广播还需要在会议中验证。':check?.code==='extension_missing'?'尚未连接到 Chrome 插件，请按下面步骤完成安装。':check?lanErrorText(check.code):'等待检查'}</p>
  {!enabled&&<>
   {!info.available?<p role="alert">{info.reason==='port_not_configured'?'管理员还没有统一配置获批的 UDP 端口（LAN_CLIENT_PORT）。请管理员配置一次；同事不需要自己填写。':'服务端尚未提供可用安装包，请维护人员更新为包含客户端的新镜像，并核对网站和端口配置。'}</p>:<>
    {!ready&&<div className="lan-install-prompt"><strong>这台电脑还没准备好？</strong><p>先安装辅助程序，再完成 Chrome 插件安装。只下载 EXE、没有运行安装，不能分流。</p></div>}
    <a className="button primary" href="/api/lan/client/setup.exe" onClick={()=>setDownloaded(true)}>{ready?'重新下载安装 / 修复':'① 下载 Windows 安装程序'}</a>
    {downloaded&&<p role="status">下载已请求。请打开 Chrome 右上角「下载内容」，运行 WebZoom-LAN-Setup.exe。网页不能代替你运行安装程序。</p>}
    <details open={!ready}><summary>查看安装 / 修复步骤</summary><ol className="lan-install-steps">
     <li>打开下载好的 <strong>WebZoom-LAN-Setup.exe</strong>，点击「安装 / 修复」。网站和端口已由服务器填好，不用你输入。</li>
     <li>安装 Chrome 插件：如果公司 IT 已统一下发，跳过此步。若 IT 批准本地试点，点击安装程序的「打开扩展文件夹」和「打开 Chrome 扩展页」，在 Chrome 扩展页打开「开发者模式」，点「加载已解压的扩展程序」，选择刚打开的扩展文件夹。若公司策略不允许，请交给 IT 下发，不要绕过限制。</li>
     <li>完成后刷新此网页。网页会自动检查；检查通过后点击「启用局域网分流」。不要只关闭安装窗口就当作装好了。</li>
    </ol></details>
    <details><summary>安装包对应的网站与校验信息</summary><p>网站：<code>{info.origin}</code>；UDP 端口：{info.port}</p><p className="lan-checksum">SHA-256：<code>{info.sha256}</code></p><p>仅支持 Windows 64 位与公司批准的 Chrome。当前试点安装包尚未签名；若被公司策略阻止，请联系 IT，不要关闭安全软件。</p></details>
   </>}
   <div className="lan-actions"><button className="button secondary" onClick={()=>void recheck()} disabled={checking}>{checking?'检查中…':'重新检查安装'}</button><button className="button primary" disabled={!ready||!info.available||sharing} onClick={()=>onMode(true)}>启用局域网分流</button></div>
  </>}
  {enabled&&<><p>中继和接收角色由系统自动选择。遇到未安装或连接失败，请先退出分流，按页面步骤安装。</p><button className="button secondary" disabled={sharing} onClick={()=>onMode(false)}>退出局域网分流 / 安装客户端</button></>}
  <small>页面不会自动运行 EXE 或强装 Chrome 插件。共享中不能切换模式；广播失败不会自动改为每人从服务器下载。</small>
 </section>;
}
