import {useEffect, useRef, useState} from 'react';
import type {Room} from './types';

type Props = {
  room: Room;
  userId: string;
  disabled: boolean;
  onAction: (action: string, target?: string) => Promise<unknown>;
};

export default function AnnotationRequests({room, userId, disabled, onAction}: Props) {
  const owner = room.ownerId === userId;
  const allowed = owner || !!room.annotators?.includes(userId);
  const requested = !!room.annotationRequests?.includes(userId);
  const pending = room.participants.filter(p => room.annotationRequests?.includes(p.id));
  const wasRequested = useRef(requested);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (wasRequested.current && !requested && !allowed) {
      setMessage('申请已结束，当前未获批注权限；如有需要可重新申请。');
    } else if (requested || allowed) {
      setMessage('');
    }
    wasRequested.current = requested;
  }, [requested, allowed]);

  if (owner) return <section className="annotation-requests" aria-label="批注申请">
    <h3>批注申请 <span>{pending.length}</span></h3>
    {pending.length ? <>
      <button className="button secondary" disabled={disabled} onClick={() => void onAction('annotation-approve-all')}>一键同意全部（{pending.length}）</button>
      <p className="annotation-request-note">仅同意当前申请的人，不会授权其他观众。</p>
      <ul>{pending.map(p => <li key={p.id}>
        <span className="annotation-request-name">{p.name}</span>
        <button className="annotation-permission" disabled={disabled} aria-label={`同意 ${p.name} 的批注申请`} onClick={() => void onAction('annotation-approve', p.id)}>同意</button>
        <button className="annotation-permission" disabled={disabled} aria-label={`拒绝 ${p.name} 的批注申请`} onClick={() => void onAction('annotation-deny', p.id)}>拒绝</button>
      </li>)}</ul>
    </> : <p className="annotation-request-note" role="status">暂无待处理申请</p>}
  </section>;

  return <section className="annotation-requests" aria-label="我的批注权限">
    <h3>批注权限</h3>
    <p className="annotation-request-note" role="status">{allowed ? '你已获得批注权限，共享开始后可使用画笔或指示光标。' : requested ? '已申请，等待主持人同意。' : message || '需要画画或指示时，可以向主持人申请批注权限。'}</p>
    {!allowed && <button className="button secondary" disabled={disabled} onClick={() => void onAction(requested ? 'annotation-cancel' : 'annotation-request')}>{requested ? '取消申请' : '申请批注'}</button>}
  </section>;
}
