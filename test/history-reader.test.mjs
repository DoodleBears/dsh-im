import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExternalHistory } from '../src/channels/feishu/history-reader.mjs';
const identity = {botId:'bot-1', appId:'cli-1', botOpenId:'ou-bot', fingerprint:'a'.repeat(64)};
const route = {messageId:'om-anchor', conversationId:'oc-team', actorId:'ou-human', threadId:'omt-topic'};
const item = (id, text='hello') => ({message_id:id, chat_id:'oc-team', thread_id:'omt-topic',
 sender:{sender_type:'user', id_type:'open_id', id:'ou-human'}, msg_type:'text',
 create_time:'1790830000000', body:{content:JSON.stringify({text})}});
function client(items=[item('om-context')]) {
 const calls=[];
 return {calls, im:{v1:{message:{get:async()=>({code:0,data:{items:[item('om-anchor')]}}),
 list:async args=>{calls.push(args);return {code:0,data:{items,has_more:false}};}}}}};
}
test('uses authenticated anchor and distinguishes Chat time windows from Thread listing',async()=>{
 const bot=client();
 const result=await readExternalHistory(bot,identity,route,{scope:'nearby',limit:20});
 assert.equal(result.events[0].text,'hello'); assert.equal(result.events[0].mentionedAccount,false);
 assert.equal(bot.calls[0].params.container_id_type,'chat'); assert.equal(bot.calls[0].params.start_time,'1790829700');
 const thread=await readExternalHistory(bot,identity,route,{scope:'thread',limit:20});
 assert.equal(thread.scope,'thread'); assert.equal(bot.calls[1].params.container_id,'omt-topic');
 assert.equal(bot.calls[1].params.start_time,undefined);
});
test('omits unsupported/app/deleted messages explicitly and refuses cross-group content',async()=>{
 const bot=client([item('ok'),{...item('post'),msg_type:'post'}, {...item('deleted'),deleted:true},
 {...item('bot'),sender:{sender_type:'app',id_type:'app_id',id:'cli-1'}}]);
 const result=await readExternalHistory(bot,identity,route,{scope:'group',limit:20});
 assert.equal(result.events.length,1); assert.equal(result.omitted,3);
 await assert.rejects(readExternalHistory(client([{...item('wrong'),chat_id:'oc-other'}]),identity,route,
 {scope:'group',limit:20}),{code:'untrusted-source'});
});
test('fails closed on stale reference, permission denial, nonexistent Thread and cancellation',async()=>{
 const bot=client();
 await assert.rejects(readExternalHistory(bot,identity,{...route,actorId:'wrong'}, {scope:'group',limit:20}),{code:'stale-route'});
 assert.equal(bot.calls.length,0);
 await assert.rejects(readExternalHistory(bot,identity,{...route,threadId:undefined},{scope:'thread',limit:20}),{code:'stale-route'});
 bot.im.v1.message.get=async()=>({code:230027});
 await assert.rejects(readExternalHistory(bot,identity,route,{scope:'group',limit:20}),{code:'history-permission-denied'});
 const controller=new AbortController();controller.abort();
 await assert.rejects(readExternalHistory(client(),identity,route,{scope:'group',limit:20},controller.signal),{name:'AbortError'});
});

test('requests server names and preserves sender / mention IDs without guessing missing names', async () => {
 const named = {...item('om-named'), sender:{sender_type:'user',id_type:'open_id',id:'ou-human',sender_name:'Alex'},
 mentions:[{key:'@_user_1',id:'ou-bot',name:'QA Bot'}]};
 const bot=client([named,item('om-unnamed')]);
 const page=await readExternalHistory(bot,identity,route,{scope:'thread',limit:20});
 assert.equal(bot.calls[0].params.with_sender_name,true);
 assert.deepEqual(page.events[0].actor,{kind:'user',id:'ou-human',name:'Alex'});
 assert.deepEqual(page.events[0].mentions,[{id:'ou-bot',key:'@_user_1',name:'QA Bot'}]);
 assert.deepEqual(page.events[1].actor,{kind:'user',id:'ou-human'});
});
