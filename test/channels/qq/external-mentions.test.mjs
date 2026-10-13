import {test} from 'node:test';
import assert from 'node:assert/strict';
import {qqExternalMentions} from '../../../src/channels/qq/external-mentions.mjs';

test('QQ retains exact native mention names and tokens without changing source text', () => {
 const message={content:'<@self> hello <@peer> <@!peer>',mentions:[
  {id:'self',username:'Receiving App',is_you:true},
  {member_openid:'peer',nickname:'Peer <literal>',is_you:false},
 ]};
 assert.deepEqual(qqExternalMentions(message,{name:'Authenticated App'}),[
  {id:'self',key:'<@self>',name:'Receiving App'},
  {id:'peer',key:'<@peer>',name:'Peer <literal>'},
  {id:'peer',key:'<@!peer>',name:'Peer <literal>'},
 ]);
 assert.equal(message.content,'<@self> hello <@peer> <@!peer>');
});

test('QQ authenticated name fallback is limited to a strict receiving-App self mention', () => {
 const message={content:'<@self> <@peer> <@string-flag>',mentions:[
  {id:'self',is_you:true},{id:'peer',is_you:false},{id:'string-flag',is_you:'true'},
 ]};
 assert.deepEqual(qqExternalMentions(message,{name:'Authenticated App'}),[
  {id:'self',key:'<@self>',name:'Authenticated App'},
  {id:'peer',key:'<@peer>'},{id:'string-flag',key:'<@string-flag>'},
 ]);
});

test('QQ mention display does not guess conflicting aliases, conflicting names or absent tokens', () => {
 const message={content:'<@conflict> <@same> <@unknown>',mentions:[
  {id:'conflict',member_openid:'other',username:'Ambiguous'},
  {id:'same',username:'First'},{id:'same',username:'Second'},
  {id:'not-in-text',username:'Absent'},
  {id:'unknown',scope:'all',username:'Everyone'},
 ]};
 assert.deepEqual(qqExternalMentions(message,{}),[]);
 assert.deepEqual(qqExternalMentions({...message,mentions:Array(101).fill({id:'same',username:'Too many'})},{}),[]);
 const mentions=Array.from({length:100},(_,i)=>({id:`id-${i}`,username:'Native name'}));
 assert.deepEqual(qqExternalMentions({mentions,content:mentions.map(x=>`<@${x.id}> <@!${x.id}>`).join(' ')},{}),[]);
});

test('QQ optional display tokens respect the Core key limit without refusing longer native IDs', () => {
 for(const length of [508,509,510,512]) {
  const id='a'.repeat(length);
  const mention={id,username:'Native name'};
  const message={mentions:[mention],content:`<@${id}> <@!${id}>`};
  const result=qqExternalMentions(message,{});
  assert.deepEqual(result.map(x=>x.key),[`<@${id}>`,`<@!${id}>`].filter(key=>key.length<=512));
 }
});
