import {type Page} from '@playwright/test';
import {snapshot,type Observation} from '../relay-tests/relayHarness';
// Observe real transport objects; DO NOT replace getDisplayMedia, captureStream,
// codecs, pixels, or the media supplied to the application.
export async function observe(page:Page){
 await page.addInitScript(()=>{
  const observation:Observation=window.relayObservation={connections:[],sockets:[]};
  const Peer=window.RTCPeerConnection,Socket=window.WebSocket;
  window.RTCPeerConnection=class extends Peer {constructor(config?:RTCConfiguration){super(config);observation.connections.push(this)}};
  window.WebSocket=class extends Socket {constructor(url:string|URL,protocols?:string|string[]){super(url,protocols);observation.sockets.push(this)}};
 });
}
export async function nativeAPIs(page:Page){return page.evaluate(()=>Object.fromEntries([
 ['getDisplayMedia',navigator.mediaDevices.getDisplayMedia],['canvasCaptureStream',HTMLCanvasElement.prototype.captureStream],
 ['VideoEncoder',window.VideoEncoder],['VideoDecoder',window.VideoDecoder],['MediaStreamTrackProcessor',MediaStreamTrackProcessor],
].map(([name,fn])=>[name,Function.prototype.toString.call(fn)])))}
export async function pixel(page:Page){return page.locator('canvas.screen-canvas').evaluate((canvas:HTMLCanvasElement)=>{
 const context=canvas.getContext('2d');if(!context||!canvas.width||!canvas.height)return [];
 return Array.from(context.getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data);
})}
export async function displayedQuality(page:Page){return {
 snapshot:await snapshot(page),stage:await page.locator('.stage-bottom').innerText(),quality:await page.locator('.quality-card').innerText(),
 visibility:await page.evaluate(()=>document.visibilityState),
}}
export async function rtc(page:Page){return page.evaluate(async()=>{
 return Promise.all((window.relayObservation?.connections??[]).filter(c=>c.connectionState==='connected').map(async connection=>{
  const stats=await connection.getStats(),rows=Array.from(stats.values());
  const transport=rows.find(s=>s.type==='transport'&&s.selectedCandidatePairId);
  const pair=transport?stats.get(transport.selectedCandidatePairId):rows.find(s=>s.type==='candidate-pair'&&s.nominated&&s.state==='succeeded');
  const local=pair&&stats.get(pair.localCandidateId),remote=pair&&stats.get(pair.remoteCandidateId);
  return {state:connection.connectionState,localProtocol:local?.protocol,remoteProtocol:remote?.protocol,
   localCandidateType:local?.candidateType,remoteCandidateType:remote?.candidateType,
   dataChannels:rows.filter(s=>s.type==='data-channel').map(s=>({state:s.state,bytesSent:s.bytesSent,bytesReceived:s.bytesReceived,messagesSent:s.messagesSent,messagesReceived:s.messagesReceived}))};
 }));
})}
