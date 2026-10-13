import {afterEach,expect,it,vi} from 'vitest';
import {APIError,isBandwidthLimitError,request} from './api';
afterEach(()=>vi.unstubAllGlobals());
it('identifies admission refusal by server code, not a generic 503',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('bandwidth limit exceeded',{status:503,headers:{'X-WebZoom-Error':'bandwidth_limit'}})));
 let rejected:unknown;try{await request('/api/rooms')}catch(error){rejected=error}
 expect(isBandwidthLimitError(rejected)).toBe(true);
 expect(isBandwidthLimitError(new APIError(503,'identity provider unavailable'))).toBe(false);
 expect(isBandwidthLimitError(new APIError(429,'capacity reached'))).toBe(false);
});
