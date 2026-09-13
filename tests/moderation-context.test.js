import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startService,testConfig} from './helpers.js';

async function pair(service){
 const a=service.client(),b=service.client();await a.profile('审核样例甲');await b.profile('审核样例乙');
 const aid=(await a.bootstrap()).user.id,bid=(await b.bootstrap()).user.id;
 const id=service.store.connectPairing(randomUUID(),aid,bid,1,1);
 return {a,b,aid,bid,id};
}
test('contextual moderation examines expressions outside keyword rules and keeps high confidence harassment unsent',async t=>{
 const config=testConfig();config.ai.configured=true;
 const service=await startService(t,{config}),p=await pair(service);let payload;
 t.mock.method(service.ai,'json',async(_system,input)=>{payload=input;return{category:'harassment',confidence:.97};});
 const response=await p.a.request(`/api/conversations/${p.id}/messages`,{method:'POST',body:{text:'我会不停联系你直到你愿意见我，拒绝也没有用。',clientMessageId:randomUUID()}});
 assert.equal(response.status,422);assert.match(payload.message,/不停联系/);
 assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
 assert.equal(service.moderation.cases(p.aid)[0].decision,'block');
});
test('normal knowledge disagreements can pass contextual review while explicit risk is held during model failure',async t=>{
 const config=testConfig();config.ai.configured=true;
 const service=await startService(t,{config}),p=await pair(service);
 t.mock.method(service.ai,'json',async()=>({category:'safe',confidence:.94}));
 assert.equal((await p.a.request(`/api/conversations/${p.id}/messages`,{method:'POST',body:{text:'我不同意这个推论，因为实验样本没有控制年龄变量。',clientMessageId:randomUUID()}})).status,201);
 t.mock.method(service.ai,'json',async()=>{throw new Error('fixture unavailable');});
 assert.equal((await p.a.request(`/api/conversations/${p.id}/messages`,{method:'POST',body:{text:'你去死，我会找到你。',clientMessageId:randomUUID()}})).status,422);
 assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
 assert.equal(service.moderation.cases(p.aid)[0].decision,'review');
});
test('legacy person endpoints do not bypass individual consents for real people',async t=>{
 const service=await startService(t),p=await pair(service);let calls=0;
 for(const method of ['explain','icebreakers'])t.mock.method(service.ai,method,async()=>{calls++;throw new Error('No external processing is allowed');});
 t.mock.method(service.zhihu,'search',async()=>{calls++;throw new Error('No search is allowed');});
 for(const path of ['explain','icebreakers']){
   const response=await p.a.request(`/api/people/${p.bid}/${path}`,{method:'POST'});
   assert.equal(response.status,200);assert.equal(response.data.mode,'rules');
 }
 assert.equal(calls,0);
});
