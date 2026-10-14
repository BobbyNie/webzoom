import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {videoRect, type AnnotationState} from './annotations';
import {currentPointers, focusCenter, latestFeedback, type FeedbackMode} from './feedbackGeometry';
import './presenter-feedback.css';

type Props = {stream: MediaStream; state: AnnotationState; onStop: () => void};
type PiP = {window: Window | null; requestWindow: (options?: {width?: number; height?: number}) => Promise<Window>};
function pictureInPicture(): PiP | undefined {
  return (window as Window & {documentPictureInPicture?: PiP}).documentPictureInPicture;
}

export default function PresenterFeedback({stream, state, onStop}: Props) {
  const [popup, setPopup] = useState<Window | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const owned = useRef<Window | null>(null);
  const alive = useRef(false);
  const pending = useRef(false);
  const track = stream.getVideoTracks()[0];
  const surface = track?.getSettings().displaySurface;
  const captureRisk = surface !== 'window' && surface !== 'browser';
  const supported = window.isSecureContext && !!pictureInPicture();

  useEffect(() => {
    alive.current = true;
    const close = () => { owned.current?.close(); owned.current = null; };
    window.addEventListener('pagehide', close);
    return () => { alive.current = false; window.removeEventListener('pagehide', close); close(); };
  }, []);

  async function open() {
    if (pending.current) return;
    if (owned.current && !owned.current.closed) { owned.current.focus(); return; }
    const api = pictureInPicture();
    if (!api) return;
    pending.current = true;
    setOpening(true);
    setError('');
    let next: Window | null = null;
    try {
      // Must be called directly from a user gesture, before any other await.
      next = await api.requestWindow({width: 720, height: 520});
      if (!alive.current || track?.readyState !== 'live') { next.close(); return; }
      const doc = next.document;
      doc.title = 'WebZoom · 共享者反馈';
      doc.documentElement.lang = 'zh-CN';
      // Reuse only this application's external CSS. No inline script, token,
      // pairing code, popup URL or relaxed CSP is needed.
      for (const sheet of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
        if (new URL(sheet.href).origin === location.origin) doc.head.append(sheet.cloneNode(true));
      }
      doc.body.className = 'feedback-window';
      owned.current = next;
      const opened = next;
      opened.addEventListener('pagehide', () => {
        if (owned.current !== opened) return;
        owned.current = null;
        if (alive.current) setPopup(null);
      }, {once: true});
      setPopup(opened);
    } catch {
      next?.close();
      if (alive.current) setError('小窗未能打开。请直接点击按钮重试；若公司浏览器策略禁用了画中画，请联系 IT。共享不会因此停止。');
    } finally {
      pending.current = false;
      if (alive.current) setOpening(false);
    }
  }

  return <section className="presenter-feedback" aria-label="共享者反馈小窗">
    <div className="feedback-intro"><div><h3>一边共享，一边看反馈 <span>纯网页 · 无需安装</span></h3>
      <p>小窗置顶显示共享画面、同事的画笔和带姓名的指示光标。不会移动你的鼠标。</p></div>
      <button className="button secondary" disabled={!supported || opening} onClick={() => void open()}>
        {opening ? '正在打开…' : popup ? '定位反馈小窗' : '打开反馈小窗'}
      </button>
    </div>
    {!supported && <p className="feedback-warning" role="status">当前浏览器或策略不支持置顶网页小窗。请使用支持 Document Picture-in-Picture 的桌面 Chrome / Edge；普通新窗口不能保证置顶，因此不会悄悄替代。</p>}
    {captureRisk && <p className="feedback-warning">整屏共享可能把小窗也拍进去。建议把小窗移到未共享的第二块屏幕，或改为共享业务窗口 / 标签页；若出现重复画面，切换小窗的“仅标注”。网页不能保证自动排除小窗。</p>}
    <small>反馈显示在小窗内，不会直接覆盖原应用。关闭小窗不会停止共享；停止共享、离开会议或连接中断会关闭小窗。换页、滚动后请清除旧笔迹。</small>
    {error && <p role="alert" className="feedback-warning">{error}</p>}
    {popup && !popup.closed && createPortal(<FeedbackWindow popup={popup} stream={stream} state={state} captureRisk={captureRisk} onStop={onStop}/>, popup.document.body)}
  </section>;
}

function FeedbackWindow({popup, stream, state, captureRisk, onStop}: Props & {popup: Window; captureRisk: boolean}) {
  const [mode, setMode] = useState<FeedbackMode>('overview');
  const [now, setNow] = useState(Date.now());
  const [videoError, setVideoError] = useState(false);
  const [dimensions, setDimensions] = useState(() => {
    const settings = stream.getVideoTracks()[0]?.getSettings();
    return {width: settings?.width ?? 0, height: settings?.height ?? 0};
  });
  const [box, setBox] = useState({width: 0, height: 0});
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const focus = useRef(latestFeedback(state, Date.now())?.point ?? {x: .5, y: .5});
  const feedback = latestFeedback(state, now);
  const pointers = currentPointers(state, now);
  // Retain the last point after a laser expires; do not jump to an old stroke.
  const lastState = useRef(state);
  if (lastState.current !== state) {
    lastState.current = state;
    if (feedback) focus.current = feedback.point;
    else if (!state.strokes.length && !pointers.length) focus.current = {x: .5, y: .5};
  }
  useEffect(() => {
    // Run the expiration clock in the visible PiP document, not a hidden tab.
    const id = popup.setInterval(() => setNow(Date.now()), 100);
    return () => popup.clearInterval(id);
  }, [popup]);
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const measure = () => setBox({width: node.clientWidth, height: node.clientHeight});
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = video.current;
    if (!node || mode === 'annotations') return;
    let disposed = false;
    setVideoError(false);
    const measure = () => {
      if (node.videoWidth && node.videoHeight) setDimensions({width: node.videoWidth, height: node.videoHeight});
    };
    const failed = () => setVideoError(true);
    node.addEventListener('error', failed);
    node.addEventListener('loadedmetadata', measure);
    node.addEventListener('resize', measure);
    node.srcObject = stream;
    void node.play().catch(() => { if (!disposed) setVideoError(true); });
    return () => {
      disposed = true;
      node.removeEventListener('error', failed);
      node.removeEventListener('loadedmetadata', measure);
      node.removeEventListener('resize', measure);
      node.pause(); node.srcObject = null;
      // Never stop these tracks: the meeting publisher owns their lifecycle.
    };
  }, [stream, mode]);

  const rect = videoRect(box.width, box.height, dimensions.width, dimensions.height);
  const zoom = mode === 'focus' ? 2 : 1;
  const center = mode === 'focus' ? focusCenter(focus.current) : {x: .5, y: .5};
  const content = {left: rect.left + rect.width * (.5 - center.x * zoom), top: rect.top + rect.height * (.5 - center.y * zoom), width: rect.width * zoom, height: rect.height * zoom};
  return <main className="feedback-shell">
    <header className="feedback-header"><div><span className="feedback-live-dot"/> <strong>共享者反馈</strong><small>本机预览 · 同步会议标注</small></div>
      <button type="button" onClick={() => popup.close()} aria-label="关闭反馈小窗">关闭</button></header>
    <nav className="feedback-modes" aria-label="反馈显示方式">
      <button aria-pressed={mode === 'overview'} onClick={() => setMode('overview')}>完整画面</button>
      <button aria-pressed={mode === 'focus'} onClick={() => setMode('focus')}>跟随指示 ×2</button>
      <button aria-pressed={mode === 'annotations'} onClick={() => setMode('annotations')}>仅标注</button>
    </nav>
    {captureRisk && <p className="feedback-capture-warning">整屏可能拍入此窗：移到未共享屏幕，或切换“仅标注”避免画面套娃。</p>}
    <div className={`feedback-stage ${mode === 'annotations' ? 'annotations-only' : ''}`} ref={stage} data-testid="feedback-stage">
      <div className="feedback-content" style={content} data-testid="feedback-content">
        {mode !== 'annotations' && <video ref={video} muted autoPlay playsInline aria-label="本机共享画面" data-testid="feedback-video"/>}
        {mode === 'annotations' && <span className="feedback-map-label">共享屏幕位置示意 · 不含业务画面</span>}
        <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="同事的画笔" data-testid="feedback-strokes">
          {state.strokes.map(stroke => stroke.points.length === 1 ?
            <circle key={`${stroke.user.id}:${stroke.id}`} cx={stroke.points[0].x * 1000} cy={stroke.points[0].y * 1000} r="2" fill={stroke.color}/> :
            <polyline key={`${stroke.user.id}:${stroke.id}`} points={stroke.points.map(p => `${p.x * 1000},${p.y * 1000}`).join(' ')} stroke={stroke.color} strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
          )}
        </svg>
        {pointers.map(pointer => <span key={pointer.user.id} className={`feedback-pointer ${pointer.point.x > .65 ? 'label-left' : ''}`} style={{left: `${pointer.point.x * 100}%`, top: `${pointer.point.y * 100}%`, color: pointer.color}} data-testid="feedback-pointer">
          <span className="feedback-laser"/><span className="feedback-pointer-name">{pointer.user.name}</span>
        </span>)}
      </div>
      {videoError && mode !== 'annotations' && <p className="feedback-video-error" role="alert">画面预览未能播放，请关闭后重开小窗；标注仍可查看。</p>}
      {!rect.width && <p className="feedback-video-error" role="status">正在等待共享画面尺寸…</p>}
      {mode === 'focus' && <div className="feedback-minimap" aria-label="放大区域在原画面中的位置"><span style={{left: `${(center.x - .25) * 100}%`, top: `${(center.y - .25) * 100}%`}}/></div>}
    </div>
    <div className="feedback-caption" data-testid="feedback-caption">{feedback ? <><strong>{feedback.name}</strong> 的{pointers.length ? '指示光标' : '画笔'}{mode === 'focus' ? ' · 跟随最近收到的指示位置' : ''}</> : '等待同事的画笔或指示 · 主持人可授予批注权限'}</div>
    <footer className="feedback-footer"><span>只显示反馈，不控制鼠标。换页 / 滚动后请清除旧笔迹。<br/>画面是本机预览；同事看到的画面会有网络延迟。</span><button type="button" onClick={onStop}>停止共享</button></footer>
  </main>;
}
