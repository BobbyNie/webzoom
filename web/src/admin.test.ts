import {describe,it,expect} from 'vitest';
import {trafficRate} from './adminMetrics';
describe('admin media rate',()=>{
 it('uses two server timestamps and decimal megabits',()=>{
  expect(trafficRate(1000000,6000000,5000)).toBe('8.00 Mbps');
 });
 it('does not invent rates for first samples or reset counters',()=>{
  expect(trafficRate(undefined,6000000,5000)).toBe('等待采样');
  expect(trafficRate(6000000,1,5000)).toBe('等待采样');
  expect(trafficRate(0,1,0)).toBe('等待采样');
 });
});
