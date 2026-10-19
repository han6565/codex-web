import type { WaitDynamicToolConfig } from './wait-dynamic-tool.js';
export const JUDGMENT_TOOL_NAME='codex_web_judgments';
export const JUDGMENT_TOOL_SPEC={type:'function' as const,name:JUDGMENT_TOOL_NAME,
 description:'Create, query, revise and review personal predictions and long-term ideas in normal server-project conversations. Start with context for exact schemas, then list/detail. Preserve original wording, probability and criteria; never invent the user probability. Durable one-time checks use the existing project queue. Store core evidence, submit proposed or rule-verified results; public semantic outcomes require the user to confirm in the UI. Missing evidence is never false. Only write in the current project.',
 inputSchema:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['context','list','detail','create','revise','schedule','cancel','evidence','submit','note']},id:{type:'string',description:'Judgment ID for detail and mutations'},data:{type:'object',additionalProperties:true,description:'Read context for action schemas. Every mutation requires requestKey; existing records require revision.'}}}};
export async function callJudgmentTool(config:WaitDynamicToolConfig,args:unknown):Promise<string>{
 const response=await fetch(`${config.baseUrl.replace(/\/$/,'')}/api/automation/jobs/${encodeURIComponent(config.jobId)}/judgments`,{method:'POST',headers:{authorization:`Bearer ${config.token}`,'content-type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(30000)});
 const result=await response.json() as Record<string,unknown>;if(!response.ok)throw new Error(typeof result.error==='string'?result.error:`判断簿操作失败 (${response.status})`);return JSON.stringify(result);
}
