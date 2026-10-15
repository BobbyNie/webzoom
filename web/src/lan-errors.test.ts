import {it,expect} from 'vitest';
import {lanErrorText} from './lan-errors';
it('maps bounded native faults to actionable Chinese, never echoes arbitrary errors',()=>{
 expect(lanErrorText('native_missing')).toContain('EXE');
 expect(lanErrorText('port_unavailable')).toContain('其他 LAN 会议');
 expect(lanErrorText('network_unsupported')).toContain('不要自行关闭公司 VPN');
 expect(lanErrorText('secret local path')).not.toContain('secret');
 expect(lanErrorText('__proto__')).toContain('检查安装和网络');
 expect(lanErrorText(null)).toContain('不会自动改为直连');
});
