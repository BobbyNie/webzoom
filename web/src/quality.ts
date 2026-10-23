export const profiles = [
 {width:1920,height:1080,fps:30,bitrate:6_000_000,label:'1080p · 30 fps'},
 {width:1920,height:1080,fps:30,bitrate:4_000_000,label:'1080p · 30 fps · 降低码率'},
 {width:1280,height:720,fps:30,bitrate:3_000_000,label:'720p · 30 fps'},
 {width:1280,height:720,fps:15,bitrate:1_800_000,label:'720p · 15 fps'},
 {width:1280,height:720,fps:10,bitrate:1_200_000,label:'720p · 10 fps'},
];
export class Adaptation {
 level=0; private lastChange=-Infinity;private lastCongestion=-Infinity;
 private windowStart:number|null=null;private deliveredFrames=0;private healthySince:number|null=null;
 private resetHealth(){this.windowStart=null;this.deliveredFrames=0;this.healthySince=null;}
 congested(now:number){
  this.lastCongestion=now;this.resetHealth();
  if(now-this.lastChange>=3000){this.level=Math.min(profiles.length-1,this.level+1);this.lastChange=now;}
 }
 // Count successful sends, not merely captured/queued frames or missing feedback.
 delivered(now:number){if(this.level>0){if(this.windowStart===null)this.windowStart=now;this.deliveredFrames++;}}
 stable(now:number){
  if(this.level===0||this.windowStart===null)return;
  const elapsed=now-this.windowStart;if(elapsed<1000)return;
  // Static content is legitimately sparse. It must not trigger a downgrade, but
  // neither sparse content nor a suspended event loop proves spare capacity.
  const healthy=elapsed<=2000&&this.deliveredFrames*1000/elapsed>=profiles[this.level].fps*.8;
  if(healthy){if(this.healthySince===null)this.healthySince=this.windowStart;}
  else this.healthySince=null;
  this.windowStart=now;this.deliveredFrames=0;
  if(this.healthySince!==null&&now-this.healthySince>=30000&&now-this.lastCongestion>=30000&&now-this.lastChange>=30000){
   this.level--;this.lastChange=now;this.resetHealth();
  }
 }
}
