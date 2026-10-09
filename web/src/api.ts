export class APIError extends Error{constructor(public status:number,message:string){super(message)}}
export async function request<T>(path:string,csrf?:string,body?:unknown):Promise<T>{
 const res=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf??''},body:body===undefined?undefined:JSON.stringify(body)});
 if(!res.ok)throw new APIError(res.status,await res.text());return res.status===204?undefined as T:res.json();
}
