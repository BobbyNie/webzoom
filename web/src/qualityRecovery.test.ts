import {expect,it} from 'vitest';
import {Adaptation,profiles} from './quality';
function healthy(a:Adaptation,from:number,seconds:number){
 for(let i=0;i<=seconds*30;i++){const now=from+i*1000/30;a.stable(now);a.delivered(now)}
}
it('does not mistake absent congestion messages for healthy output',()=>{
 const a=new Adaptation();a.congested(0);a.congested(3100);
 a.stable(34000);a.stable(65000);expect(a.level).toBe(2);
});
it('does not upgrade an input that only produces one delivered frame per second',()=>{
 const a=new Adaptation();a.congested(0);a.congested(3100);
 for(let now=4000;now<=100000;now+=1000){a.stable(now);a.delivered(now)}
 expect(a.level).toBe(2);
});
it('requires thirty seconds of actual healthy delivery before a one-step upgrade',()=>{
 const a=new Adaptation();a.congested(0);a.congested(3100);
 healthy(a,4000,29);expect(a.level).toBe(2);
 healthy(a,33000,2);expect(a.level).toBe(1);expect(profiles[a.level].height).toBe(1080);
 a.stable(65000);expect(a.level).toBe(1);
});
it('resets the healthy window after congestion even if the level cannot change yet',()=>{
 const a=new Adaptation();a.congested(0);a.congested(3100);healthy(a,4000,29);
 a.congested(33000);const level=a.level;healthy(a,34000,29);expect(a.level).toBe(level);
 healthy(a,63000,2);expect(a.level).toBe(level-1);
});
it('does not count a long scheduler pause as healthy recovery time',()=>{
 const a=new Adaptation();a.congested(0);a.congested(3100);healthy(a,4000,20);
 a.stable(90000);a.delivered(90000);healthy(a,90000,29);expect(a.level).toBe(2);
 healthy(a,119000,2);expect(a.level).toBe(1);
});
it('uses the current target rate when recovering from a lower frame-rate profile',()=>{
 const a=new Adaptation();for(let now=0;now<=9000;now+=3000)a.congested(now);
 expect(a.level).toBe(4);
 for(let i=0;i<=310;i++){const now=10000+i*100;a.stable(now);a.delivered(now)}
 expect(a.level).toBe(3);
});
