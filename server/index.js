import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const service = createApp(config);
const server = service.app.listen(config.port, config.host, () => {
  console.log(`同知已启动：http://${config.host}:${config.port}`);
  console.log(`文本分析：${config.ai.configured ? '已配置模型' : '规则模式'}；知乎登录：${config.zhihu.oauthConfigured ? '已配置' : '尚未配置'}`);
});
let stopping = false;
function shutdown() {
  if (stopping) return; stopping = true;
  server.close(() => process.exit(0));
  service.close();
  setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 3000).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
