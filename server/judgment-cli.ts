#!/usr/bin/env node
import fs from 'node:fs';
import { callJudgmentTool } from './judgment-tool.js';
async function main(){
 const file=process.argv[2];if(!file||file==='--help'){process.stdout.write('Usage: node "$CODEX_WEB_JUDGMENT_CLI" request.json\nRead {"action":"context"} for schemas. Credentials are provided by the current normal project job.\n');return;}
 const baseUrl=process.env.CODEX_WEB_AUTOMATION_BASE_URL,token=process.env.CODEX_WEB_AUTOMATION_TOKEN,jobId=process.env.CODEX_WEB_AUTOMATION_JOB_ID;
 if(!baseUrl||!token||!jobId)throw new Error('当前任务没有判断簿接口凭据。');
 process.stdout.write(await callJudgmentTool({baseUrl,token,jobId,receiptDirectory:''},JSON.parse(fs.readFileSync(file,'utf8')))+'\n');
}
void main().catch(e=>{process.stderr.write((e instanceof Error?e.message:'判断簿操作失败')+'\n');process.exitCode=1;});
