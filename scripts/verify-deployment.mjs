import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';

const origin=process.env.TONGZHI_VERIFY_ORIGIN || 'https://zhihu.aiimage.icu';
const report={checkedAt:new Date().toISOString(),origin,checks:[],humanOAuth:'pending-user-confirmation'};
const cookies=new Map();let csrf='',temporaryUser=false;
async function request(path,{method='GET',body,admin=false,token}={}){
 const response=await fetch(origin+path,{method,redirect:'manual',headers:{origin,cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...(!['GET','HEAD'].includes(method)?{'content-type':'application/json','x-csrf-token':token??csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 for(const cookie of response.headers.getSetCookie()){
   const pair=cookie.split(';')[0],i=pair.indexOf('='),key=pair.slice(0,i),value=pair.slice(i+1);
   if(value)cookies.set(key,value);else cookies.delete(key);
 }
 const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
 return{response,data};
}
function passed(label){report.checks.push({label,status:'passed'});}
try{
 const health=await request('/api/health');assert.equal(health.response.status,200);assert.equal(health.data.version,'2.0.0');passed('HTTPS health serves merged application 2.0.0');
 const home=await request('/');assert.equal(home.response.status,200);assert.match(home.data,/<title>同知/);assert.match(home.response.headers.get('content-security-policy'),/frame-ancestors 'none'/);passed('Main document and CSP belong to the merged app');
 const assets=[...home.data.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(m=>m[1]);
 for(const asset of assets){const found=await request(asset);assert.equal(found.response.status,200);}
 passed('Referenced application assets return 200');
 const bootstrap=await request('/api/bootstrap');assert.equal(bootstrap.response.status,200);csrf=bootstrap.data.csrf;temporaryUser=true;
 assert.deepEqual(bootstrap.data.capabilities,{ai:true,embedding:false,oauth:true,zhihuData:true,zhihuSearch:true});
 const issued=bootstrap.response.headers.getSetCookie().find(value=>value.startsWith('tongzhi_session='));assert.match(issued,/HttpOnly/);assert.match(issued,/Secure/);passed('Configured integrations and separate secure visitor cookie');
 const unauthorized=await request('/api/admin/users');assert.equal(unauthorized.response.status,401);passed('Ordinary visitor has no admin access');
 for(const path of ['/data/tongzhi.sqlite','/server/config.js','/.env.local','/docs/API.md'])assert.equal((await request(path)).response.status,404);
 passed('Database, environment, source and internal documents are not served');
 const oauth=await request('/api/auth/zhihu/start',{method:'POST',body:{}});assert.equal(oauth.response.status,200);
 const authorize=new URL(oauth.data.url);assert.equal(authorize.origin,'https://openapi.zhihu.com');assert.equal(authorize.searchParams.get('app_id'),'400');assert.equal(authorize.searchParams.get('redirect_uri'),origin+'/auth/callback');assert.ok(authorize.searchParams.get('state'));
 passed('OAuth URL uses App 400, per-request state and exact registered callback; authorization not automated');
 const start=await request('/auth/callback?state=invalid-deployment-check&code=invalid-deployment-check');assert.equal(start.response.status,302);
 const callback=await request(start.response.headers.get('location'));assert.equal(callback.response.status,302);assert.match(callback.response.headers.get('location'),/auth=state_error/);passed('Invalid OAuth state rejected without exchanging credentials');
 if(process.env.TONGZHI_ADMIN_ACCESS_FILE){
   const access=JSON.parse(readFileSync(process.env.TONGZHI_ADMIN_ACCESS_FILE,'utf8'));
   const session=await request('/api/admin/session');assert.equal(session.response.status,200);
   const login=await request('/api/admin/login',{method:'POST',token:session.data.csrf,body:{username:access.username||'admin',password:access.password}});assert.equal(login.response.status,200);assert.equal(login.data.authenticated,true);
   const overview=await request('/api/admin/overview');assert.equal(overview.response.status,200);assert.ok(overview.data.counts.totalUsers>=22);assert.ok(overview.data.circles.total>=4);
   const logout=await request('/api/admin/logout',{method:'POST',token:login.data.csrf,body:{}});assert.equal(logout.response.status,200);assert.equal((await request('/api/admin/overview')).response.status,401);passed('Existing admin credentials work, unified statistics load, logout revokes access');
 }
 report.status='passed';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
finally{
 if(temporaryUser){const removed=await request('/api/account',{method:'DELETE',body:{confirm:'delete'}});if(removed.response.status!==200){report.status='failed';report.cleanup='failed';process.exitCode=1;}else report.cleanup='isolated visitor removed';}
 const content=JSON.stringify(report,null,2)+'\n';if(process.env.TONGZHI_VERIFY_REPORT)writeFileSync(process.env.TONGZHI_VERIFY_REPORT,content,{mode:0o600});
 console.log(content);
}
