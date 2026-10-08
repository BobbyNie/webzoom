interface DisplayMediaStreamOptions {systemAudio?: 'include'|'exclude'}

declare class MediaStreamTrackProcessor {
 constructor(options:{track:MediaStreamTrack;maxBufferSize?:number});
 readable:ReadableStream<VideoFrame>;
}
