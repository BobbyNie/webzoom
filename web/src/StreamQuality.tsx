import {profiles} from './quality';
import type {MediaStats} from './media';
export default function StreamQuality({level,stats,active}:{level:number;stats:MediaStats;active:boolean}){
 return <div className={`quality-card ${level>0?'degraded':''}`}><p className="eyebrow">STREAM STATUS</p><strong>{level>0?'已自动降低目标画质':'画质目标'}</strong><p>目标：{profiles[level]?.label??profiles[0].label}</p><p data-testid="actual-quality">{!active?'当前未在共享':stats.width&&stats.height?`实际：${stats.width} × ${stats.height} · ${stats.fps} fps`:'实际：等待画面'}</p><small>已处理 <span data-testid="frames">{stats.frames}</span> 帧</small></div>;
}