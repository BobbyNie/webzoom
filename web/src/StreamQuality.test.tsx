import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import StreamQuality from './StreamQuality';
const stats={width:1920,height:984,fps:10,level:0,frames:700};
function text(active=true,level=0){return renderToStaticMarkup(<StreamQuality active={active} level={level} stats={stats}/>).replace(/<[^>]*>/g,'')}
it('separates the requested quality target from the measured frame rate',()=>{
 expect(text()).toContain('目标：1080p · 30 fps');expect(text()).toContain('实际：1920 × 984 · 10 fps');
});
it('does not show an old frame rate as live playback when sharing has stopped',()=>{
 expect(text(false)).toContain('当前未在共享');expect(text(false)).not.toContain('实际：1920');
});
it('labels adaptive quality as a target, not a promise of delivered frame rate',()=>{
 expect(text(true,3)).toContain('目标：720p · 15 fps');expect(text(true,3)).toContain('实际：1920 × 984 · 10 fps');
});