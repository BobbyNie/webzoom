import {useCallback, useEffect, useRef, useState} from 'react';
import {APIError, request} from './api';
import type {Identity, Room} from './types';

export function MyMeetings({identity, onUnauthorized}: {identity: Identity; onUnauthorized: () => void}) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Room | null>(null);
  const [ending, setEnding] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError('');
    try {
      const next = await request<Room[]>('/api/rooms');
      if (current === generation.current) setRooms(next);
    } catch (e) {
      if (current !== generation.current) return;
      if ((e as APIError).status === 401) onUnauthorized();
      else setError('无法读取会议列表。请刷新后重试。');
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [identity.user.id, onUnauthorized]);
  useEffect(() => {
    void refresh();
    const onFocus = () => {void refresh();};
    window.addEventListener('focus', onFocus);
    return () => {generation.current++; window.removeEventListener('focus', onFocus);};
  }, [refresh]);
  useEffect(() => {
    if (selected) dialog.current?.showModal();
    else dialog.current?.close();
  }, [selected]);
  async function copy(room: Room) {
    setError(''); setNotice('');
    try {
      await navigator.clipboard.writeText(`${location.origin}/m/${encodeURIComponent(room.id)}`);
      setNotice('会议链接已复制。');
    } catch {setError('无法复制链接。请进入会议后复制地址栏中的链接。');}
  }
  async function end() {
    if (!selected || ending) return;
    setEnding(true); setError(''); setNotice('');
    try {
      await request(`/api/rooms/${encodeURIComponent(selected.id)}/actions`, identity.csrf, {action: 'end'});
      setRooms(current => current.filter(room => room.id !== selected.id));
      setSelected(null); setNotice('会议已结束。原链接已失效。');
      await refresh();
    } catch (e) {
      const status = (e as APIError).status;
      if (status === 401) onUnauthorized();
      else if (status === 404) {setSelected(null); setNotice('会议已结束或已过期。'); await refresh();}
      else {setSelected(null); setError(status === 403 ? '你没有结束此会议的权限。请刷新列表。' : '无法结束会议。请重试。');}
    } finally {setEnding(false);}
  }
  return <section className="my-meetings" aria-labelledby="my-meetings-title">
    <div className="my-meetings-heading"><div><p className="eyebrow">YOUR MEETINGS</p><h2 id="my-meetings-title">我创建的会议</h2></div>
      <button className="button secondary" disabled={loading || ending} onClick={() => void refresh()}>刷新列表</button></div>
    <p className="panel-description">离开页面或停止共享不会结束会议。结束会议后，原链接将失效。</p>
    {loading && <p role="status">正在读取会议列表…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!loading && !error && rooms.length === 0 && <p className="meetings-empty">你还没有未结束的会议。</p>}
    <div className="owned-meetings-list">{rooms.map(room => <article className="owned-meeting" key={room.id} aria-label={`会议 ${room.id}`}>
      <div><h3>会议 <span>{room.id.slice(0, 8)}</span></h3><p className={room.active ? 'meeting-status live' : 'meeting-status'}>{room.active ? '正在共享' : '等待共享'}</p>
        <p className="meeting-dates">创建于 {new Date(room.createdAt).toLocaleString()}<br/>最迟结束于 {new Date(room.expiresAt).toLocaleString()}</p></div>
      <div className="meeting-actions"><a className="button primary" href={`/m/${encodeURIComponent(room.id)}`}>进入会议</a>
        <button className="button secondary" onClick={() => void copy(room)}>复制链接</button><button className="button danger" disabled={ending} onClick={() => setSelected(room)}>结束会议</button></div>
    </article>)}</div>
    <dialog ref={dialog} className="modal meeting-end-dialog" aria-labelledby="owned-end-title" onCancel={event => {if (ending) event.preventDefault(); else setSelected(null);}} onClose={() => setSelected(null)}>
      <p className="eyebrow">END MEETING</p><h2 id="owned-end-title">结束这场会议？</h2>
      <p>会议 {selected?.id.slice(0, 8)}</p><p>所有参与者将断开连接。此会议链接将失效。</p>
      <div><button className="button secondary" disabled={ending} onClick={() => setSelected(null)}>取消</button>
        <button className="button danger" disabled={ending} onClick={() => void end()}>{ending ? '正在结束…' : '确认结束'}</button></div>
    </dialog>
  </section>;
}
