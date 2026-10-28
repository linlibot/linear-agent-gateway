export const WELCOME_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Linear Agent · 本地网关</title>
<style>
:root{font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif;color:#20212c;background:#f4f5f9;color-scheme:light}*{box-sizing:border-box}body{margin:0}main{width:min(1040px,100%);margin:auto;padding:36px 24px 48px}.top{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.mark{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:#5e61d7;color:#fff;font-weight:750;font-size:21px}h1{font-size:24px;margin:0;letter-spacing:-.6px}.status{margin-left:auto;background:#fff;border:1px solid #dedfea;border-radius:30px;padding:7px 12px;font-size:12px;color:#737685}.ok{color:#16734b;background:#e9f7ef;border-color:#cdebd9}.bad{color:#b23e40;background:#fff1f1;border-color:#f0d3d3}.intro{color:#737685;font-size:14px;line-height:1.75;margin:18px 0 26px}.grid{display:grid;grid-template-columns:minmax(0,360px) minmax(0,1fr);gap:20px}.card{background:white;border:1px solid #e2e3ec;border-radius:17px;padding:24px;box-shadow:0 3px 16px #27244d04}h2{font-size:16px;margin:0 0 21px}label,.label{font-size:12px;font-weight:650;color:#656879;display:block;margin:18px 0 8px}code{font:12px/1.8 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}.field{background:#f6f7fb;border:1px solid #ececf3;padding:11px 12px;border-radius:9px}.note{font-size:12px;line-height:1.8;color:#7b7e8d;margin:16px 0 0}.pill{display:inline-block;background:#efeffd;color:#5d5fc5;padding:4px 8px;border-radius:5px;font-size:11px;margin-bottom:2px}.headrow{display:flex;align-items:center;justify-content:space-between}button{font:inherit;cursor:pointer;border:1px solid #dedfeb;border-radius:8px;padding:8px 12px;background:#fff;color:#535669;font-size:12px}button:hover{border-color:#7475dc}button:disabled{opacity:.5;cursor:wait}.primary{background:#5e61d7;color:#fff;border-color:#5e61d7;padding:11px 20px;font-size:13px;font-weight:600}input,select,textarea{font:inherit;width:100%;border:1px solid #dedfea;border-radius:9px;background:#fff;padding:11px 12px;font-size:13px;color:#292c3c;outline:none}input:focus,select:focus,textarea:focus{border-color:#7779df;box-shadow:0 0 0 3px #6567dc13}textarea{resize:vertical;min-height:90px;line-height:1.7}.messages{margin-top:20px;display:flex;flex-direction:column;gap:12px;max-height:330px;overflow:auto}.message{border-radius:10px;padding:12px 14px;line-height:1.75;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f6fa}.message.user{background:#eeeeff;margin-left:24px}.message.error{background:#fff1f1;color:#a6373d}.empty{text-align:center;font-size:13px;color:#9699a7;padding:20px 0}.actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px}.muted{font-size:11px;color:#9295a4}footer{font-size:11px;color:#9699a7;margin-top:22px;line-height:1.8}a{color:#6062c4;text-decoration:none}@media(max-width:700px){main{padding:24px 16px}.grid{grid-template-columns:1fr}.status{margin-left:0}.card{padding:20px}h1{font-size:21px}}
</style>
</head>
<body><main>
<div class="top"><div class="mark">L</div><h1>Linear Agent 本地网关</h1><span id="status" class="status">正在检查服务</span></div>
<p class="intro">使用已有的 Linear 登录会话对话。这里可以查看客户端配置，也可以直接发送一条测试消息。</p>
<div class="grid">
<section class="card"><div class="headrow"><h2 style="margin:0">客户端接入</h2><span class="pill">Chat Completions</span></div>
<div class="label">API Base URL</div><div class="field"><code id="base"></code></div><button id="copy" style="margin-top:9px">复制地址</button>
<div class="label">模型入口</div><div class="field"><code>linear-agent</code></div><p class="note">右侧模型列表中的已测参数也可填入客户端的 model 字段。</p>
<div class="label">调用 API Key</div><div class="field"><a href="/keys" target="_blank" rel="noopener">创建和管理自己的调用 Key →</a></div><p class="note">用管理员账号密码登录后台后，自行生成或填写调用 Key，再填入客户端。调用会使用已导入的 Linear 账号池。</p>
<p class="note">添加或更新 Linear 登录凭证，请打开 <a href="/accounts" target="_blank" rel="noopener">账户管理</a>。每个账户分别导入，不能把 Cookie 填进本地 API Key 输入框。</p>
<p class="note">API Base URL 是给客户端使用的接口前缀；现在直接打开 <code>/v1</code> 也会显示本页。</p>
</section>
<section class="card"><div class="headrow"><h2 style="margin:0">对话测试</h2><button id="new">新对话</button></div>
<form id="chat"><label for="model">模型请求参数</label><select id="model" aria-label="模型请求参数"><option value="linear-agent">Linear 默认配置</option></select>
<p class="note" id="modelnote">候选模型名通过请求与回复测试后才会出现在列表中。上游未返回可核验的实际模型身份。</p>
<label for="effort">思考强度</label><select id="effort" aria-label="思考强度"><option value="auto">默认（跟随 Linear）</option><option value="low">低 · Low</option><option value="medium">中 · Medium</option><option value="high">高 · High</option></select><p class="note">低 / 中 / 高为请求档位，实际计算预算仍由 Linear 决定。</p>
<label for="key">API Key</label><input id="key" type="password" autocomplete="off" placeholder="粘贴自己创建的调用 Key，或原管理员 Key" required>
<label for="account">使用账户</label><div class="headrow" style="gap:10px"><select id="account" aria-label="使用账户"><option value="">自动选号（按账户策略）</option></select><button id="accounts-refresh" type="button">刷新账户</button></div><p class="note"><a href="/accounts" target="_blank" rel="noopener">账户与轮转策略</a> · 自动选号按策略分配新对话；手动选择和续聊使用固定账户。</p>
<div id="messages" class="messages" aria-live="polite"><div class="empty" id="empty">发送第一条消息，开始一个新对话</div></div>
<label for="prompt">消息</label><textarea id="prompt" placeholder="例如：请用一句话介绍你能做什么" required></textarea>
<div class="actions"><span id="state" class="muted">准备就绪</span><button id="send" class="primary" type="submit">发送消息</button></div></form>
</section></div>
<footer>Compose 默认只映射宿主机本机端口。通过轮询读取 Linear 回复：SSE 只转发轮询时已稳定的文本，上游只在结束时给出回复则一次输出。客户端工具调用为实验性结构化适配。<a href="/health" target="_blank" rel="noopener">查看健康状态</a></footer>
</main>
<script>
const $=id=>document.getElementById(id);let conversationId=null;let conversationAccountId=null;let busy=false;
$('base').textContent=location.origin+'/v1';
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText(location.origin+'/v1');$('copy').textContent='已复制';}catch{$('copy').textContent='请选中上方地址复制';}};
function message(text,type){$('empty')?.remove();const item=document.createElement('div');item.className='message '+type;item.textContent=text;$('messages').append(item);item.scrollIntoView({block:'nearest'});}
function reset(){conversationId=null;conversationAccountId=null;$('messages').replaceChildren();const empty=document.createElement('div');empty.id='empty';empty.className='empty';empty.textContent='发送第一条消息，开始一个新对话';$('messages').append(empty);$('state').textContent='准备就绪';}
$('new').onclick=()=>{if(!busy)reset();};$('model').onchange=()=>{if(!busy)reset();};
function modelOptions(list){const previous=$('model').value;$('model').replaceChildren();for(const model of list.data){const option=document.createElement('option');option.value=model.id;option.textContent=model.name+(model.test_status==='reply_received'?' · 参数已实测':'');$('model').append(option);}if([...$('model').options].some(o=>o.value===previous))$('model').value=previous;}
async function refreshModels(){const key=$('key').value.trim();const account=conversationAccountId||$('account').value;const response=await fetch(key?'/v1/models'+(account?'?account_id='+encodeURIComponent(account):''):'/ui/models',{headers:key?{authorization:'Bearer '+key}:{}});const data=await response.json();if(!response.ok)throw Error(data.error?.message??'读取模型列表失败');modelOptions(data);}
async function refreshAccounts(){const key=$('key').value.trim();if(!key)throw Error('请先填写 API Key。');const response=await fetch('/v1/accounts',{headers:{authorization:'Bearer '+key}});const data=await response.json();if((response.status===403&&data.error?.code==='admin_key_required')||(response.status===401&&data.error?.code==='admin_login_required')){$('account').replaceChildren();const automatic=document.createElement('option');automatic.value='';automatic.textContent='自动选号 · 使用已配置的账号池';$('account').append(automatic);await refreshModels();return false;}if(!response.ok)throw Error(data.error?.message??'读取账户失败');const selected=$('account').value;const defaultAccount=data.data.find(a=>a.id===data.default_account_id);$('account').replaceChildren();const option=document.createElement('option');option.value='';option.textContent=data.routing_policy?.strategy==='round_robin'?'自动选号 · 按新对话轮转':'自动选号 · 固定默认'+(defaultAccount?'（'+defaultAccount.label+'）':'');$('account').append(option);for(const account of data.data){const item=document.createElement('option');item.value=account.id;item.textContent='固定 · '+account.label;$('account').append(item);}if([...$('account').options].some(o=>o.value===selected))$('account').value=selected;await refreshModels();return true;}
const refreshed=admin=>{$('state').textContent=admin?'账户列表已更新':'调用 Key 已就绪 · 使用账号池自动选号';};$('accounts-refresh').onclick=()=>refreshAccounts().then(refreshed).catch(e=>{$('state').textContent=e.message;});$('key').onchange=()=>{if(!busy){reset();if($('key').value.trim())refreshAccounts().then(refreshed).catch(e=>{$('state').textContent=e.message;});}};$('account').onchange=()=>{if(!busy){reset();refreshModels().catch(e=>{$('state').textContent=e.message;});}};
Promise.all([fetch('/health').then(r=>r.json()),fetch('/ui/models').then(r=>r.json())]).then(([health,list])=>{
if(health.status!=='ok')throw Error('unhealthy');$('status').textContent='本地服务运行中';$('status').classList.add('ok');
modelOptions(list);
}).catch(()=>{$('status').textContent='服务连接失败';$('status').classList.add('bad');});
$('chat').onsubmit=async event=>{event.preventDefault();if(busy)return;const text=$('prompt').value.trim(),key=$('key').value.trim();if(!text||!key)return;
busy=true;for(const id of ['send','new','model','effort','account','accounts-refresh'])$(id).disabled=true;$('state').textContent='等待 Linear 回复…';message(text,'user');$('prompt').value='';
try{const body={model:$('model').value,messages:[{role:'user',content:text}]};if($('effort').value!=='auto')body.reasoning_effort=$('effort').value;if(conversationId)body.conversation_id=conversationId;const account=conversationAccountId||$('account').value;if(account)body.account_id=account;
const response=await fetch('/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify(body)});const data=await response.json();if(!response.ok||data.error)throw Error(data.error?.message??'请求失败');
conversationId=data.conversation_id;conversationAccountId=data.account_id;message(data.choices[0].message.content,'assistant');$('state').textContent='已回复 · '+(data.routing?.failover_count?'换号重试 '+data.routing.failover_count+' 次 · ':'')+'续聊使用原账户';
}catch(error){message(error.message,'error');$('state').textContent='请求未完成';}
finally{busy=false;for(const id of ['send','new','model','effort','account','accounts-refresh'])$(id).disabled=false;}};
</script></body></html>`;
