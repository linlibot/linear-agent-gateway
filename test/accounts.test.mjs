import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import vm from 'node:vm';
import { AccountStore, accountIdFor, sessionFromCredentials } from '../accounts.mjs';
import { createGateway } from '../gateway.mjs';
import { ENDPOINT, GatewayError } from '../upstream.mjs';
import { loadModelEntries } from '../models.mjs';
import { ACCOUNTS_HTML } from '../accounts-page.mjs';
import { WELCOME_HTML } from '../welcome.mjs';
import { KEYS_HTML } from '../keys-page.mjs';

const session = (user='user-a', organization='org-a', cookie='TEST_COOKIE_A') => ({ endpoint:ENDPOINT, headers:{cookie,user,organization} });
const response = data => new Response(JSON.stringify({data}),{headers:{'content-type':'application/json'}});
async function fixture(t, { legacy, fetchImpl } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'linear-accounts-test-'));
  t.after(async()=>{
    const resolved=path.resolve(temp);
    assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('linear-accounts-test-'));
    await fs.rm(resolved,{recursive:true,force:true});
  });
  const runtime=pathToFileURL(temp+path.sep);
  const legacyFile=new URL('linear-session.json',runtime);
  if(legacy)await fs.writeFile(legacyFile,JSON.stringify(legacy));
  const store=new AccountStore(runtime,{fetchImpl});
  await store.initialize(legacyFile);
  return {store,runtime,legacyFile};
}

test('credential parsing extracts only the exact Linear Agent request and necessary headers',()=>{
  const har={log:{entries:[{request:{url:ENDPOINT,postData:{text:'aiConversationSendMessage'},headers:[
    {name:'User',value:'user-a'},{name:'Organization',value:'org-a'},
    {name:'Authorization',value:'DO_NOT_STORE'},{name:'X-Unrelated',value:'DO_NOT_STORE'}
  ],cookies:[{name:'linear',value:'TEST_COOKIE_A'}]}}]}};
  const parsed=sessionFromCredentials(JSON.stringify(har));
  assert.equal(parsed.headers.cookie,'linear=TEST_COOKIE_A');
  assert.equal(parsed.headers.user,'user-a');
  assert(!JSON.stringify(parsed).includes('DO_NOT_STORE'));
  assert.throws(()=>sessionFromCredentials({log:{entries:{}}}),e=>e.status===400);
  assert.throws(()=>sessionFromCredentials({...session(),endpoint:'https://example.com/graphql'}),e=>e.status===400);
  assert.throws(()=>sessionFromCredentials({...session(),headers:{user:'a',organization:'a'}}),e=>e.status===400);
  assert.throws(()=>sessionFromCredentials(session('a','a','bad\r\nheader')),e=>e.status===400);
  har.log.entries[0].request.url='https://example.com/graphql';
  assert.throws(()=>sessionFromCredentials(har),e=>e.status===400);
});

test('distinct identities are preserved and reimport refreshes only the same account',async t=>{
  const {store}=await fixture(t);
  const a=await store.import(session(),'个人');
  const b=await store.import(session('user-b','org-b','TEST_COOKIE_B'),'工作');
  assert.notEqual(a.account.id,b.account.id);
  const updated=await store.import(session('user-a','org-a','REFRESHED_COOKIE'));
  assert.equal(updated.updated,true);
  assert.equal(updated.account.label,'个人');
  const list=await store.list();
  assert.equal(list.data.length,2);
  assert.equal(list.default_account_id,a.account.id);
  assert.equal((await store.get(b.account.id)).session.headers.cookie,'TEST_COOKIE_B');
  assert.equal((await store.get(a.account.id)).session.headers.cookie,'REFRESHED_COOKIE');
  assert(!JSON.stringify(list).includes('COOKIE'));
  assert(!JSON.stringify(list).includes('headers'));
  assert.notEqual(accountIdFor(session('user-a','org-b')),a.account.id);
});

test('default changes and restart preserve conversation affinity and reject account mismatch',async t=>{
  const {store,runtime,legacyFile}=await fixture(t,{legacy:session()});
  const a=(await store.list()).default_account_id;
  const b=(await store.import(session('user-b','org-b'),'工作')).account.id;
  const id=randomUUID();
  await store.pin(id,a);
  await store.setDefault(b);
  assert.equal((await store.resolve()).id,b);
  assert.equal((await store.resolve({conversationId:id})).id,a);
  await assert.rejects(store.resolve({accountId:b,conversationId:id}),e=>e.status===409);
  const restarted=new AccountStore(runtime);await restarted.initialize(legacyFile);
  assert.equal((await restarted.resolve({conversationId:id})).id,a);
  const old=await restarted.resolve({conversationId:randomUUID()});
  assert.equal(old.id,a);assert.equal(old.needsConversationCheck,true);
});

test('legacy model evidence is migrated only to its original account',async t=>{
  const {store,runtime,legacyFile}=await fixture(t);
  await fs.unlink(new URL('accounts.json',runtime));
  await fs.writeFile(legacyFile,JSON.stringify(session()));
  const id=randomUUID();
  await fs.writeFile(new URL('model-validation.json',runtime),JSON.stringify({tests:[{requested_model:'openai/gpt-6.1-sol',request_accepted:true,reply_received:true,conversation_id:id}]}));
  await store.initialize(legacyFile);
  const a=(await store.list()).default_account_id;
  const b=(await store.import(session('user-b','org-b'))).account.id;
  assert.equal((await loadModelEntries(store.modelReportPath(a))).length,2);
  assert.equal((await loadModelEntries(store.modelReportPath(b))).length,1);
  assert.equal((await store.resolve({conversationId:id})).needsConversationCheck,false);
});

test('credential checks verify both identities without returning secrets or raw upstream errors',async t=>{
  let mode='valid';
  const {store}=await fixture(t,{fetchImpl:async(url,options)=>{
    assert.equal(url,ENDPOINT);
    assert.match(JSON.parse(options.body).query,/^query LinearAccountCheck/);
    if(mode==='error')return new Response(JSON.stringify({errors:[{message:'TEST_COOKIE_A',extensions:{code:'AUTHENTICATION_ERROR'}}]}),{status:400});
    return response({viewer:{id:'user-a',name:'个人'},organization:{id:mode==='mismatch'?'other':'org-a',name:'工作区'}});
  }});
  const a=(await store.import(session())).account.id;
  assert.equal((await store.check(a)).status,'valid');
  mode='mismatch';assert.equal((await store.check(a)).status,'invalid');
  mode='error';const result=await store.check(a);assert.equal(result.status,'invalid');
  assert(!JSON.stringify(result).includes('COOKIE'));
});

async function apiFixture(t) {
  const {store}=await fixture(t,{fetchImpl:async()=>response({viewer:{id:'user-a',name:'个人'},organization:{id:'org-a',name:'工作区'}})});
  const a=(await store.import(session(),'个人')).account.id;
  const b=(await store.import(session('user-b','org-b','TEST_COOKIE_B'),'工作')).account.id;
  const calls=[];let fail=false;let accessible=true;
  const server=createGateway({apiKey:'local-test',accountStore:store,timeoutMs:2000,clientFactory:account=>{
    calls.push(['factory',account.id]);
    return {
      call:async()=>{calls.push(['preflight',account.id]);return {aiConversation:accessible?{id:'accessible'}:null};},
      chat:async(input,signal,onAccepted)=>{
        calls.push(['send',account.id]);
        if(fail)throw new GatewayError(401,'linear_session_expired','Refresh this account.');
        const conversationId=input.conversationId??randomUUID();
        await onAccepted(conversationId);
        return {text:'OK',conversationId};
      }
    };
  }});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>server.shutdown());
  const base='http://127.0.0.1:'+server.address().port;
  const request=(route,body,auth=true)=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{...(auth?{authorization:'Bearer local-test'}:{}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const chat=body=>request('/v1/chat/completions',{model:'linear-agent',messages:[{role:'user',content:'hello'}],...body});
  return {store,a,b,calls,request,chat,setFail:value=>fail=value,setAccessible:value=>accessible=value};
}

test('gateway preserves native continuation across default changes and rejects explicit cross-account use before sending',async t=>{
  const {store,a,b,calls,chat}=await apiFixture(t);
  const firstResponse=await chat({account_id:a});const first=await firstResponse.json();
  assert.equal(firstResponse.status,200);assert.equal(first.account_id,a);
  assert.equal(firstResponse.headers.get('x-linear-account-id'),a);
  await store.setDefault(b);
  const second=await (await chat({conversation_id:first.conversation_id})).json();
  assert.equal(second.account_id,a);
  const count=calls.length;
  const denied=await chat({account_id:b,conversation_id:first.conversation_id});
  assert.equal(denied.status,409);assert.equal(calls.length,count);
  const third=await (await chat({})).json();assert.equal(third.account_id,b);
});

test('unknown conversations require read access before mutation and do not try another account',async t=>{
  const {a,calls,chat,setAccessible,setFail}=await apiFixture(t);
  setAccessible(false);
  const missing=await chat({account_id:a,conversation_id:randomUUID()});
  assert.equal(missing.status,409);
  assert.deepEqual(calls.map(c=>c[0]),['factory','preflight']);
  calls.length=0;setFail(true);
  const failed=await chat({account_id:a});assert.equal(failed.status,401);
  assert.deepEqual(calls,[['factory',a],['send',a]]);
});

test('account APIs require the local key and return only safe account metadata',async t=>{
  const {a,request}=await apiFixture(t);
  assert.equal((await request('/v1/accounts',undefined,false)).status,401);
  const page=await request('/accounts',undefined,false);assert.equal(page.status,200);
  assert((await page.text()).includes('导入账户凭证'));
  const imported=await request('/v1/accounts/import',{credential:JSON.stringify(session()),label:'更新账户'});
  assert.equal(imported.status,200);const result=await imported.json();
  assert.equal(result.updated,true);assert.equal(result.account.id,a);assert.equal(result.account.status,'valid');
  const metadata=JSON.stringify(await (await request('/v1/accounts')).json());
  assert(!metadata.includes('COOKIE'));assert(!metadata.includes('headers'));
  assert.equal((await request('/v1/accounts/import',{credential:{log:{entries:{}}}})).status,400);
});

test('all browser pages contain syntactically valid scripts',()=>{
  for(const html of [ACCOUNTS_HTML,WELCOME_HTML,KEYS_HTML]) {
    const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(()=>new vm.Script(script));
  }
});
