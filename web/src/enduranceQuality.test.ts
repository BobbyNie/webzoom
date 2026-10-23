import {expect,it} from 'vitest';
import {sustainedQuality} from '../native-capture-tests/enduranceQuality';
it('rejects a late sustained collapse hidden by the whole-run average',()=>{
 const points=[{elapsedSeconds:0,frames:[0,0]},{elapsedSeconds:600,frames:[18000,18000]},{elapsedSeconds:660,frames:[18060,18060]},{elapsedSeconds:720,frames:[18120,18120]}];
 expect(18120/720).toBeGreaterThan(25);
 const quality=sustainedQuality(points);expect(quality.passed).toBe(false);expect(quality.minimumWindowFps).toBe(1);expect(quality.windows[1].belowFloor).toEqual([0,1]);
});
it('checks each viewer and a sufficiently long trailing window',()=>{
 const quality=sustainedQuality([{elapsedSeconds:0,frames:[0,0]},{elapsedSeconds:60,frames:[1800,1800]},{elapsedSeconds:95,frames:[2850,1835]}]);
 expect(quality.passed).toBe(false);expect(quality.windows[1].belowFloor).toEqual([1]);
});
it('allows stable delivery and a short pause without calling it a sustained collapse',()=>{
 expect(sustainedQuality([{elapsedSeconds:0,frames:[0]},{elapsedSeconds:10,frames:[0]},{elapsedSeconds:60,frames:[1500]},{elapsedSeconds:120,frames:[3300]}]).passed).toBe(true);
});
it('does not accept insufficient evidence as a pass',()=>{
 expect(sustainedQuality([{elapsedSeconds:0,frames:[0]},{elapsedSeconds:10,frames:[300]}]).passed).toBe(false);
});
it('rejects missing viewers, reset counters, and invalid timestamps',()=>{
 for(const point of [{elapsedSeconds:60,frames:[]},{elapsedSeconds:60,frames:[-1]},{elapsedSeconds:0,frames:[1]},{elapsedSeconds:NaN,frames:[1]}])expect(()=>sustainedQuality([{elapsedSeconds:0,frames:[0]},point])).toThrow('Invalid endurance frame samples');
 expect(()=>sustainedQuality([{elapsedSeconds:0,frames:[10]},{elapsedSeconds:60,frames:[9]}])).toThrow();
});
