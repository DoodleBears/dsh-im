import assert from 'node:assert/strict';
import test from 'node:test';
import { qualifyExternalReply } from '../../../src/channels/feishu/reply-context.mjs';
const route = { messageId:'om-one', conversationId:'oc-team', actorId:'ou-app-a', threadId:'omt-thread', rootId:'om-root', parentId:'om-parent' };
const source = { message_id:'om-one', chat_id:'oc-team', sender:{sender_type:'user',id_type:'open_id',id:'ou-app-b'}, thread_id:'omt-thread',root_id:'om-root',parent_id:'om-parent' };
const client = response => ({im:{v1:{message:{get:async () => response}}}});

test('qualifies the same exact message/topic using the responding app-scoped sender ID without sending', async () => {
  const result = await qualifyExternalReply(client({code:0,data:{items:[source]}}), route);
  assert.deepEqual(result,{...route,actorId:'ou-app-b'});
  assert.equal(Object.isFrozen(result),true);
  assert.equal(route.actorId,'ou-app-a');
});
for (const [key,value] of [['chat_id','other'],['thread_id','other'],['root_id','other'],['parent_id','other']])
  test(`rejects mismatched ${key} without fallback`,async () => {
    await assert.rejects(qualifyExternalReply(client({code:0,data:{items:[{...source,[key]:value}]}}),route),{code:'stale-route'});
  });
for (const [code,outcome] of [[230027,'reply-permission-denied'],[99991672,'reply-permission-denied'],[99991679,'reply-permission-denied'],[1,'source-unavailable']])
  test(`keeps provider error ${code} distinct from missing message`,async () => {
    await assert.rejects(qualifyExternalReply(client({code}),route),{code:outcome});
  });
test('reports confirmed missing/withdrawn source independently of permissions',async () => {
  for(const items of [[],[{...source,deleted:true}]])
    await assert.rejects(qualifyExternalReply(client({code:0,data:{items}}),route),{code:'source-not-found'});
});
test('does not treat a malformed provider response as proof that the source disappeared',async () => {
  for(const response of [undefined, {}, {code:0}, {code:0,data:{}}, {code:0,data:{items:null}}, {data:{items:[]}}])
    await assert.rejects(qualifyExternalReply(client(response),route),{code:'source-unavailable'});
});
test('cancellation fences the qualification result',async () => {
  const controller=new AbortController();
  const response=client({code:0,data:{items:[source]}});
  response.im.v1.message.get=async () => {controller.abort();return {code:0,data:{items:[source]}}};
  await assert.rejects(qualifyExternalReply(response,route,controller.signal));
});
