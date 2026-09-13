# 官方 Hackathon Skill 初始化记录

使用用户指定的 `https://zhstatic.zhihu.com/skill/zhihu-hackathon-skill_v2026s2.zip`，归档 SHA-256：`d7517cad343fe5eb6bd911c4fa3edc7b21dd665d43caad4e73438c1ef849f112`。安装前确认所有路径都位于 `zhihu-hackathon/`，没有绝对路径、父目录跳转或符号链接。

完整 Skill 位于 `.codex/skills/zhihu-hackathon/`，随包官方 `zhihu` Skill 通过自带安装脚本及 SHA-256 校验安装到 `.codex/skills/zhihu/`。两个 Skill 保持上游原内容。当前服务器复用已安装且兼容的官方 Linux CLI `0.6.0`：`/root/.local/share/zhihu-cli/current/zhihu-cli`；为旧版 Skill 指定 `ZHIHU_CLI_HOME=/root/.local/share/zhihu-cli` 即可调用。

## 已完成

用户已明确选择接入知乎登录。现有完整应用继续开发；官方生成器需要空目录，因此在服务器 `/root/.local/share/tongpin/zhihu-oauth-init` 生成独立 OAuth 参考项目并完成官方流程，再把公共配置与凭证管理接入本项目。

- 官方 `init_project.mjs` 生成 OAuth 参考项目，App ID `400`，回调为 `https://zhihupipei.aiimage.icu/auth/callback`。
- `doctor.mjs` 检查通过：所需文件齐全、没有明文密钥配置、CLI 可用、两类部署凭证均配置。
- 参考项目 `npm test` 的两项测试与 `npm run check` 通过。
- 实际运行参考项目，`/api/health` 正常，`/api/oauth/status` 显示已配置、尚未完成个人授权，随后停止参考服务。
- 官方 CLI `auth status --verify` 成功，`me contents --type all --limit 1` 成功返回一项。验证记录只保留成功状态和条数，不保存内容或凭证。
- 正式域名的登录发起接口已启用，并验证能够跳转知乎官方登录页，测试访客随后已删除。
- 用户已亲自完成正式网站授权并确认登录成功。服务端只读检查确认已建立知乎账号；记录只保存这个布尔结果，不读取或保存账号资料与凭证。

记录：[初始化检查](../artifacts/zhihu-initialization.json)、[CLI 验证](../artifacts/zhihu-cli-validation.json)、[公网授权入口](../artifacts/zhihu-public-validation.json)。

## 正式应用中的配置

`hackathon.config.json` 只保存项目名、App ID 和公网回调。App Key 与 Access Secret 在 `/etc/soulmatch/` 的独立 `0600` 文件内，通过 systemd `LoadCredential` 注入应用，详见 [部署说明](DEPLOYMENT.md)。没有使用仅适用于 macOS 的钥匙串脚本；Linux 服务器使用 Skill 允许的部署凭证分支。

平台登记与应用配置必须使用同一个地址：

```text
https://zhihupipei.aiimage.icu/auth/callback
```

该入口将参数交给既有 `/api/auth/zhihu/callback` 处理，后者绑定当前浏览器、当前会话、一次性 state 和十分钟时限。`authorization_code` 与 `code` 均兼容。认证码和 Token 不写入日志或验证报告。

## 本人授权与用户接口验证

用户已经在自己的浏览器完成「连接知乎」并确认登录成功，满足官方 Skill 的要求：“用户必须亲自点击知乎授权页的最终确认按钮。”测试浏览器只验证官方登录入口，未代点确认；其 `authorized: false` 与正式用户的成功登录分别记录，不相互替代。

五项 OAuth 用户接口需要在已授权用户的会话中各读取至多一条。本轮未从用户浏览器提取会话，尚未执行这组公网验收；CLI 的本人凭证验收不等同于 OAuth 用户接口验收。

| 用户接口 | 公网实测状态 |
| --- | --- |
| 创作 | 待验证 |
| 关注 | 待验证 |
| 收藏夹 | 待验证 |
| 收藏夹内容 | 待验证；依赖第一条收藏夹的 `UrlToken`，无收藏夹时按空数据记录 |
| 近期收藏 | 待验证 |

官方资料记录过回调缺少 state 的协议偏差。本应用保持严格校验，缺失或不匹配会拒绝登录。账号基础信息采用当前官方基础信息文档中的字段，不把猜测出的身份写入账号记录。

## 清理

仅在用户明确要求时停止参考服务并移除参考项目或安装的 Skill。正式服务和凭证用于当前网站，不随参考项目的临时清理一起删除；若要下线作品，按部署文档逐项处理。
