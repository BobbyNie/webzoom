import {describe,it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import BrowserRelayPanel,{reception} from './BrowserRelayPanel';
import {emptyRelayStatus} from './browserRelay';
import type {BrowserOverview,BrowserParticipant} from './browserRelayProtocol';
const row:BrowserParticipant={user:{id:'leaf',name:'同事甲'},role:'peer',reason:'同伴供流',parent:'root',children:0,reportedAt:10000,report:{generation:2,peerBytes:1048576,centerBytes:0,sentBytes:0,verifiedFrames:10,planFrames:5,mediaAgeMs:0,rejected:0}};
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
