import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {validateCounters} from './resourceCounters';
import type {Browser,CDPSession,Page} from '@playwright/test';
const exec=promisify(execFile);
export interface ResourceProbe {browser:Browser;label:string;browserSession:CDPSession;pageSession:CDPSession}
export async function resourceProbe(browser:Browser,page:Page,label:string):Promise<ResourceProbe>{
 const browserSession=await browser.newBrowserCDPSession(),pageSession=await page.context().newCDPSession(page);
 await pageSession.send('Performance.enable');return {browser,label,browserSession,pageSession};
}
export async function sampleResources(probes:ResourceProbe[]){
 const incompleteSamples:{reportedProcessCount:number;sampledProcessCount:number;missingIds:number[]}[]=[];
 for(let attempt=0;attempt<3;attempt++){
  const active=probes.filter(probe=>probe.browser.isConnected());
  const pages=await Promise.all(active.map(async probe=>{
   const [metrics,dom,processes]=await Promise.all([probe.pageSession.send('Performance.getMetrics'),probe.pageSession.send('Memory.getDOMCounters'),probe.browserSession.send('SystemInfo.getProcessInfo')]);
   const values=Object.fromEntries(metrics.metrics.map(item=>[item.name,item.value]));
   return {label:probe.label,heapUsedBytes:values.JSHeapUsedSize,heapTotalBytes:values.JSHeapTotalSize,dom,processes:processes.processInfo.map(p=>({id:p.id,type:p.type,cpuTimeSeconds:p.cpuTime}))};
  }));
  const ids=[...new Set(pages.flatMap(page=>page.processes.map(p=>p.id)))];
  if(!ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw Error('Invalid test-browser process IDs');
  // Only query numeric IDs reported by our isolated test browsers, never enumerate
  // unrelated apps. Read-only process counters; no process control or credentials.
  const command=`$ErrorActionPreference='Stop'; @(Get-Process -Id @(${ids.join(',')}) -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PrivateMemorySize64,HandleCount) | ConvertTo-Json -Compress`;
  const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000,maxBuffer:1024*1024});
  const {processes,missingIds,complete}=validateCounters(ids,stdout.trim()?JSON.parse(stdout):[]);
  if(!complete){incompleteSamples.push({reportedProcessCount:ids.length,sampledProcessCount:processes.length,missingIds});await delay(100);continue;}
  return {pages,processes,incompleteSamples,samplingAttempts:attempt+1,totalWorkingSetBytes:processes.reduce((sum,p)=>sum+p.WorkingSet64,0),totalPrivateBytes:processes.reduce((sum,p)=>sum+p.PrivateMemorySize64,0),totalHandles:processes.reduce((sum,p)=>sum+p.HandleCount,0),reportedProcessCount:ids.length,sampledProcessCount:processes.length,scope:'Isolated test-browser processes only; working sets may include shared pages. JS heap is not total browser/native video memory; counters do not by themselves prove absence of leaks.'};
 }
 throw Error('Incomplete browser process memory samples after three fresh reads: '+JSON.stringify(incompleteSamples));
}
