import {describe,it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import BrowserRelayPanel,{reception} from './BrowserRelayPanel';
import {emptyRelayStatus} from './browserRelay';
import type {BrowserOverview,BrowserParticipant} from './browserRelayProtocol';
const row:BrowserParticipant={user:{id:'leaf',name:'同事甲'},role:'peer',reason:'同伴供流',parent:'root',children:0,reportedAt:10000,report:{sharing:{centerBytes:0,peerBytes:1048576,sentBytes:0},generation:2,peerBytes:1048576,centerBytes:0,sentBytes:0,verifiedFrames:10,planFrames:5,mediaAgeMs:0,rejected:0}};
const overview:BrowserOverview={generation:2,active:true,generatedAt:10000,receivedAt:20000,maxViewers:32,maxFanout:3,participants:[row]};
describe('relay reception dashboard',()=>{
 it('does not claim success from historic bytes, missing reports, stale reports or stalled media',()=>{
  expect(reception(row,overview,20000).label).toBe('同伴收流正常');
  expect(reception(row,overview,29000).label).toContain('上报中断');
  expect(reception({...row,report:undefined},overview,20000).label).toContain('等待接收端上报');
  expect(reception({...row,report:{...row.report!,planFrames:0}},overview,20000).receiving).toBe(false);
  expect(reception({...row,report:{...row.report!,mediaAgeMs:4001}},overview,20000).receiving).toBe(false);
  expect(reception(row,{...overview,active:false},20000).receiving).toBe(false);
 });
 it('labels local direction clearly and renders escaped per-person receiver values only for the owner',()=>{
  const data={...overview,receivedAt:Date.now(),participants:[{...row,user:{id:'leaf',name:'<script>not executable</script>'}}]};
  const props={status:emptyRelayStatus(),overview:data,enabled:true,disabled:false,toggle:()=>{}};
  const html=renderToStaticMarkup(<BrowserRelayPanel {...props} owner/>);
  expect(html.replace(/<[^>]*>/g,'')).toContain('每个转发节点最多带 3 位观众');
  expect(html).toContain('全员接收情况');expect(html).toContain('1.00 MB');expect(html).toContain('本机从同伴接收');expect(html).toContain('32 位观众');
  expect(html).not.toContain('最多三位观众');expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');
  expect(renderToStaticMarkup(<BrowserRelayPanel {...props} owner={false}/>)).not.toContain('全员接收情况');
 });
 it('does not turn an absent report into a received-zero claim',()=>{
  const html=renderToStaticMarkup(<BrowserRelayPanel status={emptyRelayStatus()} overview={{...overview,participants:[{...row,report:undefined}]}} enabled owner disabled={false} toggle={()=>{}}/>);
  expect(html).toContain('等待接收端上报');expect(html).toContain('>—</td>');
 });
});

describe('background and rate reporting',()=>{
 it('labels background visibility without treating it as a failure or showing stale rates',()=>{
  const now=Date.now(),background={...row,report:{...row.report!,visibility:'hidden' as const},rates:{centerBps:0,peerBps:1000000,sentBps:0,sampleMs:2000}};
  const props={status:emptyRelayStatus(),enabled:true,owner:true,disabled:false,toggle:()=>{}};
  const fresh={...overview,receivedAt:now,participants:[background]};
  const html=renderToStaticMarkup(<BrowserRelayPanel {...props} overview={fresh}/>);
  expect(html).toContain('页面在后台（不等于断流）');expect(html).toContain('同伴收流正常');expect(html).toContain('1.00 Mbps');
  const stale=renderToStaticMarkup(<BrowserRelayPanel {...props} overview={{...fresh,receivedAt:now-10000}}/>);
  expect(stale).toContain('上次上报时页面在后台，当前状态未知');expect(stale).not.toContain('1.00 Mbps');
 });
 it('defaults to the 64-viewer admission cap but honors an explicit smaller deployment cap',()=>{
  const props={status:emptyRelayStatus(),enabled:false,owner:true,disabled:false,toggle:()=>{}};
  expect(renderToStaticMarkup(<BrowserRelayPanel {...props}/>)).toContain('64 位观众');
  expect(renderToStaticMarkup(<BrowserRelayPanel {...props} maxViewers={16}/>)).toContain('16 位观众');
 });
});

 it('reports healthy direct reception without claiming peer offload or a viewing failure',()=>{
  const direct={...row,role:'direct' as const};
  expect(reception(direct,overview,20000)).toMatchObject({label:'画面接收正常 · 服务器直连',tone:'success',receiving:true});
  expect(reception({...row,serverBackup:true},overview,20000).label).toContain('正在验证同伴');
  expect(reception({...direct,report:{...row.report!,mediaAgeMs:5000}},overview,20000).receiving).toBe(false);
 });
 it('does not substitute lifetime counters when sharing counters are unavailable',()=>{
  const data={...overview,receivedAt:Date.now(),participants:[{...row,report:{...row.report!,sharing:undefined}}]};
  const html=renderToStaticMarkup(<BrowserRelayPanel status={emptyRelayStatus()} overview={data} enabled owner disabled={false} toggle={()=>{}}/>);
  expect(html).not.toContain('1.00 MB');expect(html).toContain('不会拿历史流量代替');expect(html).not.toContain('故障回退');
 });
