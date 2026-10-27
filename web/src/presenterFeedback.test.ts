import {describe, expect, it} from 'vitest';
import {emptyAnnotations} from './annotations';
import {currentPointers, focusCenter, latestFeedback} from './feedbackGeometry';

describe('presenter feedback geometry and expiry', () => {
  it('keeps a 2x crop within the image, including all four edges', () => {
    expect(focusCenter({x: 0, y: 0})).toEqual({x: .25, y: .25});
    expect(focusCenter({x: 1, y: 1})).toEqual({x: .75, y: .75});
    expect(focusCenter({x: .45, y: .7})).toEqual({x: .45, y: .7});
    expect(focusCenter({x: NaN, y: Infinity})).toEqual({x: .5, y: .5});
    expect(focusCenter({x: 0, y: 1}, 1)).toEqual({x: .5, y: .5});
  });
  it('expires laser pointers without requiring another server message', () => {
    const state = {...emptyAnnotations(), pointers: {a: {user: {id: 'a', name: 'A'}, color: '#e53935', point: {x: .1, y: .2}, updatedAt: 1000}}};
    expect(currentPointers(state, 2799)).toHaveLength(1);
    expect(currentPointers(state, 2800)).toHaveLength(0);
    expect(latestFeedback(state, 2800)).toBeNull();
  });
  it('follows the newest live pointer and falls back to the last stroke', () => {
    const state = {...emptyAnnotations(), strokes: [{id: 's', user: {id: 'a', name: 'Artist'}, color: '#e53935', segment: 0, points: [{x: .8, y: .9}]}], pointers: {
      a: {user: {id: 'a', name: 'A'}, color: '#e53935', point: {x: .1, y: .2}, updatedAt: 1000},
      b: {user: {id: 'b', name: 'B'}, color: '#e53935', point: {x: .3, y: .4}, updatedAt: 1200},
    }};
    expect(latestFeedback(state, 1500)).toEqual({point: {x: .3, y: .4}, name: 'B'});
    expect(latestFeedback(state, 4000)).toEqual({point: {x: .8, y: .9}, name: 'Artist'});
  });
  it('expires server-timed temporary ink without changing the local pointer clock', () => {
    const ink = {id:'temp', user:{id:'a',name:'Artist'},color:'#e53935',tool:'temporary' as const,expiresAt:62000,segment:0,points:[{x:.8,y:.9}]};
    const state = {...emptyAnnotations(),strokes:[ink],pointers:{a:{user:ink.user,color:ink.color,point:{x:.1,y:.2},updatedAt:1000}}};
    // Local time is one minute behind the server. Pointer timestamps are local.
    expect(latestFeedback(state,1500,61500)?.name).toBe('Artist');
    expect(latestFeedback(state,1500,63000)).toEqual({point:{x:.1,y:.2},name:'Artist'});
    expect(latestFeedback(state,3000,63000)).toBeNull();
    expect(latestFeedback({...state,pointers:{}},1500,61500)).toEqual({point:{x:.8,y:.9},name:'Artist'});
    expect(latestFeedback({...state,pointers:{}},1500,62000)).toBeNull();
  });

});
