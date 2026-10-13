export interface Traffic {ingressBytes:number;egressBytes:number}
export interface AdminRoom extends Traffic {
 id:string;active:boolean;participants:number;createdAt:string;expiresAt:string;
}
export interface BandwidthStatus {limitMbps:number;totalMbps:number;blocked:boolean;windowSeconds:number}
export interface Overview extends Traffic {
 bandwidth:BandwidthStatus;
 instanceId:string;sampledAt:string;startedAt:string;rooms:AdminRoom[];
}
export function trafficRate(previous:number|undefined,current:number,elapsedMs:number):string {
 if(previous===undefined||current<previous||elapsedMs<=0)return '等待采样';
 return `${((current-previous)*8/elapsedMs/1000).toFixed(2)} Mbps`;
}
