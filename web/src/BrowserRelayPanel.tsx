import type {RelayStatus} from './browserRelay';
const labels={off:'未开启',publisher:'共享者',root:'网页转发节点',peer:'接收同伴画面',direct:'中心直连回退',waiting:'等待供流'};
export default function BrowserRelayPanel({status:s,enabled,owner,disabled,toggle}:{status:RelayStatus;enabled:boolean;owner:boolean;disabled:boolean;toggle:()=>void}){
 return <section className="relay-panel" aria-label="网页协作分流试验" data-testid="relay-panel" data-role={s.role} data-center-bytes={s.centerBytes} data-peer-bytes={s.peerBytes} data-sent-bytes={s.sentBytes} data-rejected={s.rejected}>
  <h3>网页协作分流 · 小范围试验</h3>
  <p>不用安装插件或 EXE。仅供已获准互联的测试电脑使用；一位共享者、最多三位观众。请勿在未经批准的网络开启。</p>
  {owner&&<button className="button secondary" disabled={disabled} onClick={toggle}>{enabled?'关闭网页分流试验':'开启网页分流试验'}</button>}
  <p>状态：<strong data-testid="relay-role">{labels[s.role]}</strong> · {s.reason||'开始共享后自动安排转发'}</p>
  {enabled&&<><p>中心收到 {(s.centerBytes/1048576).toFixed(2)} MB · 已验证同伴收到 {(s.peerBytes/1048576).toFixed(2)} MB · 向同伴发出 {(s.sentBytes/1048576).toFixed(2)} MB</p><small>以上是本页连接累计媒体字节，不是公司出口节省量。{s.path}。共享期间不能切换模式；失败时仅在中心额度允许后回退，否则会暂停画面。</small></>}
 </section>;
}
