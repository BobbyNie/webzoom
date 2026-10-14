interface DisplayMediaStreamOptions {systemAudio?: 'include'|'exclude';surfaceSwitching?:'include'|'exclude'}

declare class MediaStreamTrackProcessor {
 constructor(options:{track:MediaStreamTrack;maxBufferSize?:number});
 readable:ReadableStream<VideoFrame>;
}
