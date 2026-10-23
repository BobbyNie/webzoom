/** Test-only sustained-rate gate; never infer smooth playback from whole-run averages. */
export interface EndurancePoint {elapsedSeconds:number;frames:number[]}
export function sustainedQuality(points:EndurancePoint[],minimumFps=15,windowSeconds=60){
 if(points.length<2||!Number.isFinite(minimumFps)||minimumFps<=0||!Number.isFinite(windowSeconds)||windowSeconds<30)throw Error('Invalid endurance quality configuration');
 const viewers=points[0].frames.length;
 for(let i=0;i<points.length;i++){
  const point=points[i],previous=points[i-1];
  if(!viewers||point.frames.length!==viewers||!Number.isFinite(point.elapsedSeconds)||point.elapsedSeconds<0||(previous&&point.elapsedSeconds<=previous.elapsedSeconds)||point.frames.some((count,v)=>!Number.isSafeInteger(count)||count<0||(previous&&count<previous.frames[v])))throw Error('Invalid endurance frame samples');
 }
 const windows:{fromSeconds:number;toSeconds:number;viewerFps:number[];belowFloor:number[]}[]=[];
 let anchor=points[0];
 for(let i=1;i<points.length;i++){
  const point=points[i],duration=point.elapsedSeconds-anchor.elapsedSeconds;
  if(duration<windowSeconds&&!(i===points.length-1&&duration>=windowSeconds/2))continue;
  const viewerFps=point.frames.map((frames,v)=>(frames-anchor.frames[v])/duration);
  windows.push({fromSeconds:anchor.elapsedSeconds,toSeconds:point.elapsedSeconds,viewerFps,belowFloor:viewerFps.flatMap((fps,v)=>fps<minimumFps?[v]:[])});anchor=point;
 }
 return {minimumFps,windowSeconds,windows,passed:windows.length>0&&windows.every(window=>window.belowFloor.length===0),minimumWindowFps:windows.length?Math.min(...windows.flatMap(window=>window.viewerFps)):null};
}
