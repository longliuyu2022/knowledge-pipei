# 正式域名与服务

入口为 **https://zhihu.aiimage.icu**，DNS 指向 `43.156.103.24`，HTTPS 证书由 Caddy 管理。

2026-09-13 已从筹备说明页切换为同知 `2.0.0` 正式应用。站点配置为 [deploy/zhihu-tongzhi.caddy](../deploy/zhihu-tongzhi.caddy)，安装到 `/etc/caddy/sites.d/zhihu-tongzhi.caddy`，由 `/etc/caddy/Caddyfile` 引入，反向代理到 `127.0.0.1:3033`。SSE 使用即时刷新。原同题、同频服务及域名保留。

应用服务名 `tongzhi.service`，工作目录 `/root/xiangmu/zhihu-tongzhi`，数据库 `data/tongzhi.sqlite`。后台入口 `/admin`，独立管理 Cookie，不接受普通用户会话作为管理员身份。

用户已确认在知乎平台登记 App `400` 的回调：

```text
https://zhihu.aiimage.icu/auth/callback
```

构造授权 URL 与交换令牌使用同一地址。公网授权入口、HTTPS、安全 Cookie、错误 state 拒绝已验证；开发者本人最终确认授权的状态见 [VALIDATION.md](VALIDATION.md)，自动化不会替代真人确认。

域名调整前的 Caddy 配置及筹备页快照留存在服务器私有备份目录 `/root/.local/share/tongzhi/`。`landing/` 和 [domain-validation.json](domain-validation.json) 仅保留早期筹备页的源码与历史验收，不是当前线上状态。

部署、更新和回滚见 [DEPLOYMENT.md](DEPLOYMENT.md)。
