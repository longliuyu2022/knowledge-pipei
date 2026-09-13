import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {createApp} from '../server/app.js';
import {loadConfig,projectRoot} from '../server/config.js';
import {DEFAULT_INPUT} from '../shared/catalog.js';

const directory=mkdtempSync(join(tmpdir(),'tongzhi-ice-browser-'));
const artifacts=join(projectRoot,'artifacts');mkdirSync(artifacts,{recursive:true});
const report={status:'running',checkedAt:new Date().toISOString(),checks:[],errors:[]};
const save=()=>writeFileSync(join(artifacts,'browser-icebreakers.json'),JSON.stringify(report,null,2)+'\n');
let service,server,browser;
async function check(label,run){await run();report.checks.push({label,status:'passed'});console.log('PASS '+label);save();}
try{
 execFileSync(process.execPath,[join(projectRoot,'node_modules/vite/bin/vite.js'),'build','--outDir',join(directory,'dist')],{cwd:projectRoot,stdio:'pipe'});
 const config=loadConfig(directory,{TONGZHI_DB_PATH:join(directory,'fixture.sqlite'),TONGZHI_AI_ENABLED:'false',TONGZHI_USE_LOCAL_MODEL:'false'});
 service=createApp(config);server=service.app.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${server.address().port}`;config.allowedOrigins.add(origin);
 let calls=0,searches=0;
 service.zhihu.search=async()=>{searches++;return{items:[{id:'fixture-source',title:'验收用知识资料',url:'https://www.zhihu.com/question/123',summary:'比较两种解释的证据与反例。',scope:'搜索摘要',author:'验收样例'}]};};
 service.ai.icebreakers=async()=>{calls++;return{mode:'model',questions:['我们如何比较两种解释的证据，哪一个反例最有区分力？','一个结论在什么条件下成立，哪些资料能帮助我们验证这个边界？','这周我们能否各找一份原始材料，对照其中的假设和验证方法？'],sourceIds:['fixture-source']};};
 const executablePath=['/usr/local/bin/chromium-browser','/usr/bin/chromium'].find(existsSync);
 browser=await chromium.launch({headless:true,executablePath,args:['--no-sandbox','--disable-dev-shm-usage']});
 const contexts=await Promise.all([browser.newContext({baseURL:origin,viewport:{width:1440,height:1000}}),browser.newContext({baseURL:origin,viewport:{width:390,height:844}})]);
 const pages=await Promise.all(contexts.map(c=>c.newPage()));
 const users=[];
 for(let i=0;i<pages.length;i++){
   const page=pages[i];page.on('pageerror',e=>report.errors.push(e.message));
   const boot=await(await page.request.get('/api/bootstrap')).json();users.push(boot.user.id);
   const created=await page.request.post('/api/profile',{headers:{origin,'x-csrf-token':boot.csrf},data:{input:{...DEFAULT_INPUT,name:`破冰隔离验收${i+1}`},revision:0,useAI:false}});assert.equal(created.status(),200);
 }
 const conversationId=service.store.connectPairing(randomUUID(),users[0],users[1],1,1);
 for(const page of pages)await page.goto(`/#connections?conversation=${conversationId}`);
 const [a,b]=pages;
 await check('未授权时不调用模型，知识话题与聊天均可使用',async()=>{
   await a.getByTestId('conversation-ai-consent').waitFor();await b.getByTestId('conversation-ai-consent').waitFor();
   assert.equal(await a.getByTestId('conversation-ai-consent').isChecked(),false);
   assert.equal(await a.getByTestId('conversation-starter-question').count(),3);assert.equal(calls,0);assert.equal(searches,0);
 });
 await check('仅一方同意不会向外部模型发送材料',async()=>{
   await a.getByTestId('conversation-ai-consent').check();
   await a.getByText('等待对方同意 AI 破冰；上面的知识话题仍可使用。',{exact:true}).waitFor();assert.equal(calls,0);
 });
 await check('双方同意后自动生成，有出处且只加入草稿',async()=>{
   await b.getByTestId('conversation-ai-consent').check();
   await a.locator('[data-testid="conversation-starter"][data-mode="model"]').waitFor();
   await b.locator('[data-testid="conversation-starter"][data-mode="model"]').waitFor();
   assert.equal(calls,2);assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
   await a.locator('.conversation-starter-sources summary').click();await a.getByRole('link',{name:'验收用知识资料'}).waitFor();
   await a.getByTestId('conversation-starter-question').first().click();assert.match(await a.locator('.conversation-composer textarea').inputValue(),/两种解释/);
   assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
 });
 await check('刷新复用已授权话题，撤回后两端清除模型结果',async()=>{
   await a.reload();await a.locator('[data-testid="conversation-starter"][data-mode="model"]').waitFor();assert.equal(calls,2);
   await b.getByTestId('conversation-ai-consent').uncheck();
   await a.locator('[data-testid="conversation-starter"][data-mode="rules"]').waitFor();
   assert.equal(await a.locator('.conversation-starter-sources').count(),0);
   assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM conversation_icebreakers').get().n,0);
 });
 await check('320px 和 390px 保持授权与话题可读',async()=>{
   for(const width of [390,320]){
     await a.setViewportSize({width,height:900});
     const overflow=await a.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false);
     await a.screenshot({path:join(artifacts,`icebreakers-${width}.png`),fullPage:true});
   }
 });
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;console.error(error.message);}
finally{save();await browser?.close();service?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}rmSync(directory,{recursive:true,force:true});}
