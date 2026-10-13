export class APIError extends Error{constructor(public status:number,message:string,public code?:string){super(message)}}
export async function request<T>(path:string,csrf?:string,body?:unknown,signal?:AbortSignal):Promise<T>{
 const res=await fetch(path,{signal,method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf??''},body:body===undefined?undefined:JSON.stringify(body)});
 if(!res.ok)throw new APIError(res.status,await res.text(),res.headers.get("X-WebZoom-Error")??undefined);return res.status===204?undefined as T:res.json();
}

export const bandwidthMessage="总媒体流量已超过上限。暂不允许创建会议或接入会议。";
export function isBandwidthLimitError(error:unknown):boolean{return error instanceof APIError&&error.status===503&&error.code==='bandwidth_limit'}
