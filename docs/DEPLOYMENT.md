# 同知部署与更新

生产域名 `https://zhihu.aiimage.icu`，Node.js 22.16+，Caddy 反向代理，单进程 Express + SQLite。线上仅监听 `127.0.0.1:3033`。同题 3011、同频 3022 保持各自独立运行。

## 文件与凭证

| 路径 | 用途 |
| --- | --- |
| `/root/xiangmu/zhihu-tongzhi` | 当前独立项目 |
| `data/tongzhi.sqlite` | 生产数据库，目录 0700、文件 0600 |
| `/etc/tongzhi/model.json` | 私有模型配置，包含 `api_key`、`base_url`、`model`、`protocol` |
| `/etc/tongzhi/zhihu_app_key` | 知乎 App Key |
| `/etc/tongzhi/zhihu_access_secret` | 授权用户数据及搜索所需的 Access Secret |
| `/etc/tongzhi/admin_password_hash` | 独立管理员 scrypt 密码哈希 |
| `/etc/systemd/system/tongzhi.service` | 服务单元 |
| `/etc/caddy/sites.d/zhihu-tongzhi.caddy` | 该域名的代理配置 |

`/etc/tongzhi` 为 0700，凭证文件为 0600。systemd 的 `LoadCredential` 在运行时提供密钥，模型文件通过 `%d/model_config` 引用。管理员账号沿用同频原有 `admin` 与密码哈希，不在新项目中创建默认明文密码。

首次复制配置文件时按 [.env.example](../.env.example) 与 [服务单元](../deploy/tongzhi.service) 填写自己的路径；禁止将私有文件提交到 Git，也不使用 `VITE_` 变量承载密钥。

## 当前部署

1. `npm ci`、`npm test` 和 `npm run build` 成功。
2. 在服务启动前，从只读一致性快照预演并迁移到空目标，执行 [迁移工具](MIGRATION.md) 的 `validate`。
3. 安装服务单元，运行 `systemctl daemon-reload`、`systemctl enable --now tongzhi`。
4. 确认 `http://127.0.0.1:3033/api/health` 返回 `2.0.0`。
5. 安装本站 Caddy 配置，先 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`，再 `caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`。
6. 通过公网检查健康、资源、普通用户隔离、管理员登录与准确回调。原有服务不需要重启。

应用使用 `tongzhi_session`、`tongzhi_oauth` 和 `tongzhi_admin` Cookie。重启会清理内存中的 OAuth 令牌与管理员会话，异步匹配、普通账号、站内通知及讨论保存在数据库中。

## 更新与验证

先完成代码和隔离测试，保留当前构建及一致性数据库快照，再替换构建、只重启 `tongzhi`。有数据库结构变化时先核对兼容性，避免覆盖运行中的 WAL 主文件。

```bash
npm test
npm run build
systemctl restart tongzhi
node scripts/verify-deployment.mjs
```

验证脚本会建立自己的临时访客，检查后删除，只读取公开资料，不执行真人 OAuth。设置 `TONGZHI_VERIFY_REPORT` 可保存结构化结果；可选 `TONGZHI_ADMIN_ACCESS_FILE` 指向服务器私有的 `{username,password}` JSON，仅用于管理员验证，脚本不输出凭证。不要把该私有 JSON 写入仓库。

线上健康使用 `/api/health` 与业务监控。迁移 `validate` 校验的是首次导入快照，服务已经正常产生新写入后，不应再用旧导入指纹判断系统异常。

## 数据来源与回滚

本次是新目录、新域名的独立部署，迁入截至 **2026-09-13 17:25:31（Asia/Shanghai）** 的源快照。旧站仍可独立访问，之后的新内容不自动同步；两边不共用数据库、会话或匹配请求。若将来彻底合站，需要另行设计最终写入窗口和增量对账，不能直接覆盖已有新数据。

部署失败且新库尚无新写入时，可恢复上一份代码和代理配置；原两站仍可使用。新库已有写入时，先停新服务并保全一致性快照，再决定代码回滚或向前修复；不能用源快照覆盖当前库。Caddy 只替换同知站点配置，不回滚整份全站配置而影响其他应用。

私有备份与验证记录保存在 `/root/.local/share/tongzhi`。备份属于受控运维数据，恢复前需核对快照之后的删除与撤回记录；不承诺在线注销能召回已经下载的副本。
