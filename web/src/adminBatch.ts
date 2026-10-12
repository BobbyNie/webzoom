export interface EndResponse {results:{id:string;status:string}[]}
export interface EndReport {ended:string[];notFound:string[];unconfirmed:string[];error?:unknown}
// Stop at the first uncertain batch. A lost response is not proof of failure or success.
export async function endSelectedRooms(ids:string[],send:(ids:string[])=>Promise<EndResponse>):Promise<EndReport> {
 const unique=[...new Set(ids)];
 const report:EndReport={ended:[],notFound:[],unconfirmed:[]};
 for(let i=0;i<unique.length;i+=100){
  const batch=unique.slice(i,i+100);
  try{
   const response=await send(batch),expected=new Set(batch);
   if(!response||!Array.isArray(response.results)||response.results.length!==batch.length)throw new Error('invalid termination response');
   for(const result of response.results){
    if(!result||!expected.delete(result.id)||!['ended','not_found'].includes(result.status))throw new Error('invalid termination response');
   }
   for(const result of response.results)(result.status==='ended'?report.ended:report.notFound).push(result.id);
  }catch(error){report.error=error;report.unconfirmed=unique.slice(i);break}
 }
 return report;
}
