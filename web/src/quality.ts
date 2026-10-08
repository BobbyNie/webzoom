export const profiles = [
 {width:1920,height:1080,fps:30,bitrate:6_000_000,label:'1080p · 30 fps'},
 {width:1920,height:1080,fps:30,bitrate:4_000_000,label:'1080p · 30 fps · 降低码率'},
 {width:1280,height:720,fps:30,bitrate:3_000_000,label:'720p · 30 fps'},
 {width:1280,height:720,fps:15,bitrate:1_800_000,label:'720p · 15 fps'},
 {width:1280,height:720,fps:10,bitrate:1_200_000,label:'720p · 10 fps'},
];
export class Adaptation {
 level=0; private lastChange=-Infinity;private lastCongestion=-Infinity;
 congested(now:number){this.lastCongestion=now;if(now-this.lastChange>=3000){this.level=Math.min(profiles.length-1,this.level+1);this.lastChange=now;}}
 stable(now:number){if(this.level>0&&now-this.lastCongestion>=30000&&now-this.lastChange>=30000){this.level--;this.lastChange=now;}}
}
