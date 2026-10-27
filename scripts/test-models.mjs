import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {ENDPOINT,SEND_QUERY,READ_QUERY,currentTurnParts,answerText,normalizeSession} from '../upstream.mjs';
import {AccountStore} from '../accounts.mjs';
import {CANDIDATE_MODELS} from '../models.mjs';

const runtimeDir=new URL('../.local-runtime/',import.meta.url);
const accounts=new AccountStore(runtimeDir);
await accounts.initialize(new URL('linear-session.json',runtimeDir));
const account=await accounts.resolve({accountId:process.env.LINEAR_ACCOUNT_ID});
const session=normalizeSession(account.session);
const models=Object.keys(CANDIDATE_MODELS);
const report={checkedAt:new Date().toISOString(),account_id:account.id,actual_model_identity_verified:false,tests:[]};
const reportPath=accounts.modelReportPath(account.id);
await fs.mkdir(new URL('./',reportPath),{recursive:true});
async function call(query,variables,signal){
  const response=await fetch(ENDPOINT,{method:'POST',headers:session.headers,body:JSON.stringify({query,variables}),signal});
  const result=await response.json();
  if(!response.ok||result.errors?.length){const error=new Error(result.errors?.map(e=>e.message).join('; ')??`HTTP ${response.status}`);error.code=result.errors?.[0]?.extensions?.code??'UPSTREAM_ERROR';throw error;}
  return result.data;
}
for(const model of models){
  console.log(JSON.stringify({phase:'testing',requested_model:model}));
  const started=Date.now(),signal=AbortSignal.timeout(180000);
  let id,complete=false;
  const result={requested_model:model,request_accepted:false,reply_received:false,actual_model_identity_verified:false};
  try{
    const sent=await call(SEND_QUERY,{input:{conversationId:randomUUID(),userMessageId:randomUUID(),context:[],bodyData:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'请只回复 MODEL_OK。不要调用工具或启动 coding session。'}]}]},resume:true,model}},signal);
    const accepted=sent.aiConversationSendMessage;
    if(!accepted?.success)throw new Error('Message not accepted');
    id=accepted.aiConversation.id;
    await accounts.pin(id,account.id);
    Object.assign(result,{request_accepted:true,conversation_id:id});
    for(;;){
      const data=await call(READ_QUERY,{id},signal);
      const conversation=data.aiConversation;
      const parts=currentTurnParts(conversation,accepted.assistantMessage.id);
      if(['active','pending'].includes(conversation.status)){await sleep(1500,undefined,{signal});continue;}
      complete=true;
      result.reply_status=conversation.status;
      result.reply_text=answerText(parts);
      result.reply_received=conversation.status==='complete'&&result.reply_text.trim()==='MODEL_OK';
      const errors=parts.filter(p=>p.type==='error').map(p=>p.message);
      if(errors.length)result.errors=errors;
      break;
    }
  }catch(error){result.error_code=error.code??error.name;result.error=error.message;}
  finally{
    if(id&&!complete)await call('mutation AiConversationCancel($id:String!){aiConversationCancel(id:$id){success}}',{id},AbortSignal.timeout(5000)).catch(()=>{});
  }
  result.duration_ms=Date.now()-started;
  report.tests.push(result);
  await fs.writeFile(reportPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify(result));
}
