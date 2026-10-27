import {it,expect} from 'vitest';
import {relayDiagnostics} from './relayDiagnostics';
import {emptyRelayStatus} from './browserRelay';
it('exports bounded allowlisted diagnostics, never identity, SDP, IPs, URLs or secrets',()=>{
 const sensitive='private-secret-https://company.example/room?token=abc-10.0.0.8';
 const status={...emptyRelayStatus(),reason:sensitive,path:sensitive,failure:sensitive,links:Array.from({length:9},()=>({connection:sensitive,ice:'connected',channel:'open',rttMs:20,bufferedBytes:0}))};
 const text=relayDiagnostics(status,{active:true,generation:1,generatedAt:0,maxViewers:64,maxFanout:3,participants:[{user:{id:sensitive,name:sensitive},role:'direct',reason:sensitive,parent:sensitive,children:0,reportedAt:0}]});
 expect(text).not.toContain(sensitive);expect(text).not.toContain('10.0.0.8');
 const data=JSON.parse(text);expect(data.local.links).toHaveLength(3);expect(data.local.links[0].connection).toBe('unknown');expect(data.meeting.roles.direct).toBe(1);
});
