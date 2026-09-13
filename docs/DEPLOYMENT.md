# 部署与维护

当前目标站点：`https://zhihupipei.aiimage.icu`。

## 运行结构

```text
HTTPS 443 · Caddy
    → 127.0.0.1:3022 · soulmatch.service
        → dist/ 前端
        → /api Express 服务
        → data/soulmatch.sqlite
        → 服务端配置的文本模型与可选知乎 API
```

源码目录：`/root/xiangmu/fanganer`。私有配置：`.env.local`，权限 `0600`。数据库及其 WAL 位于 `data/`，不进入代码仓库。systemd 使用严格只读的程序目录和可写数据目录，自动重启与开机启动。

## 安装与启动

在目标服务器修改 [服务模板](../deploy/soulmatch.service) 中的绝对路径，确保 Node 22.13+ 可用。安装依赖并构建，再创建数据目录、安装 service 并启动：

```bash
npm ci
npm run build
install -d -m 700 /root/xiangmu/fanganer/data
install -m 644 deploy/soulmatch.service /etc/systemd/system/soulmatch.service
systemctl daemon-reload
systemctl enable --now soulmatch.service
```

[Caddy 站点模板](../deploy/Caddyfile) 代理至 3022，自动办理 HTTPS。当前服务器将它安装在 `/etc/caddy/sites.d/zhihupipei.caddy`，主配置仅增加对应 import，原配置备份位于 `/etc/caddy/backups/`。

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
curl --fail https://zhihupipei.aiimage.icu/api/health
```

更新时先完成测试和构建，再重启应用。变更配置后也需要重启：

```bash
systemctl restart soulmatch
systemctl is-active soulmatch
journalctl -u soulmatch -n 30 --no-pager
```

## 验证公网

```bash
node scripts/verify-live.mjs
```

此命令使用真实 HTTPS 页面，验证 Secure/HttpOnly Cookie，并创建一个不公开的临时验收画像，实际调用画像、解释、破冰三项模型能力。会消耗至多三次业务调用，完成后删除验收账号。结果保存于 `artifacts/public-validation.json`；截图与参赛封面、icon 同时生成。日常健康检查只需要 `/api/health`，不必重复运行真实模型验收。

## 数据与边界

- SQLite 单实例持久化，备份时使用 SQLite 在线备份或先停止服务再复制数据库及相关 WAL；不要仅复制正在写入的主文件。
- OAuth Token 留在进程内存，重启后用户需要主动重连，已保存的应用画像与聊天仍存在。
- 开启知乎前登记准确回调地址；平台必须可靠回传 state，否则保持拒绝登录。
- 多实例运行需要将 Token、限流、实时事件和会话迁移至共享存储。
- 如需下线，仅停止 `soulmatch` 并移除这一条 Caddy import；不修改其他站点配置。
