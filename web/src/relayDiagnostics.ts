import type {RelayStatus} from './browserRelay';
import type {BrowserOverview} from './browserRelayProtocol';
import {testBuild} from './testBuild';
const number=(v:number|undefined)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:undefined;
// Deliberate allowlist: never serialize overview users, room/session IDs, SDP,
// ICE candidate addresses, location URLs, cookies, tokens or arbitrary reasons.
export function relayDiagnostics(status:RelayStatus,overview?:BrowserOverview|null){
 const roles=['off','publisher','root','peer','direct','waiting'] as const;
 const states=new Set(['new','checking','connecting','connected','completed','disconnected','failed','closed','open','closing','none']);
 const failures=new Set(['ice_failed','channel_closed','channel_error','setup_failed','negotiation_failed','key_import_failed','invalid_fragment','receive_limit','media_timeout','connection_timeout','peer_no_media','peer_stalled','connection_failed']);
 const bytes=(s:{centerBytes:number;peerBytes:number;sentBytes:number})=>({centerBytes:number(s.centerBytes),peerBytes:number(s.peerBytes),sentBytes:number(s.sentBytes)});
 return JSON.stringify({format:1,version:testBuild.version,capturedAt:new Date().toISOString(),scope:'authenticated browser self-report, not physical WAN measurement',
  local:{role:roles.includes(status.role)?status.role:'off',serverBackup:!!status.serverBackup,active:!!status.active,failure:failures.has(status.failure??'')?status.failure:undefined,
   lifetime:bytes(status),sharing:status.sharing?bytes(status.sharing):undefined,planFrames:number(status.planFrames),mediaAgeMs:number(status.mediaAgeMs),
   links:(status.links??[]).slice(0,3).map(l=>({connection:states.has(l.connection)?l.connection:'unknown',ice:states.has(l.ice)?l.ice:'unknown',channel:states.has(l.channel)?l.channel:'unknown',rttMs:number(l.rttMs),bufferedBytes:number(l.bufferedBytes)}))},
  meeting:overview?{active:overview.active,reportAgeMs:Math.max(0,Date.now()-(overview.receivedAt??Date.now())),members:overview.participants.length,
   roles:Object.fromEntries(roles.map(role=>[role,overview.participants.filter(p=>p.role===role).length]))}:undefined},null,2);
}
