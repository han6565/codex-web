import { request } from './api';
import type { Judgment, JudgmentDetail, JudgmentStats } from './judgment-types';
const write=async<T>(path:string,body:unknown)=>{
  const result=await request<T>('/judgments'+path,{method:'POST',body:JSON.stringify(body)});
  window.dispatchEvent(new Event('judgments-updated'));return result;
};
export const judgments={
  list:()=>request<{items:Judgment[];stats:JudgmentStats}>('/judgments'),
  detail:(id:string)=>request<JudgmentDetail>('/judgments/'+id),
  create:(body:unknown)=>write<JudgmentDetail>('',body),
  change:(id:string,action:string,body:unknown)=>write<JudgmentDetail>(`/${id}/${action}`,body),
  discuss:(id:string,requestKey:string)=>write<{conversationId:string;projectId:string}>(`/${id}/discuss`,{requestKey}),
};
