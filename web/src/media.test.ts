import {it,expect,vi} from 'vitest';
import {captureScreen,screenConstraints} from './media';
it('requests screen video only, never requests audio or camera',async()=>{
 const track={stop:vi.fn()},stream={getAudioTracks:()=>[],getVideoTracks:()=>[track],getTracks:()=>[track]};
 const getDisplayMedia=vi.fn().mockResolvedValue(stream);
 expect(await captureScreen({getDisplayMedia} as unknown as MediaDevices)).toBe(stream);
 expect(getDisplayMedia).toHaveBeenCalledWith(screenConstraints);
 expect(screenConstraints.audio).toBe(false);
});
it('stops every track if the browser unexpectedly returns audio',async()=>{
 const stop=vi.fn();const stream={getAudioTracks:()=>[{stop}],getTracks:()=>[{stop},{stop}]};
 await expect(captureScreen({getDisplayMedia:async()=>stream} as unknown as MediaDevices)).rejects.toThrow('音频');expect(stop).toHaveBeenCalledTimes(2);
});
it('propagates a cancelled screen picker without retrying',async()=>{
 const f=vi.fn().mockRejectedValue(new DOMException('cancelled','NotAllowedError'));
 await expect(captureScreen({getDisplayMedia:f} as unknown as MediaDevices)).rejects.toThrow();expect(f).toHaveBeenCalledTimes(1);
});
