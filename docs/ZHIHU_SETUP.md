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

## 已增加的真实会话验收入口

正式应用的「导入知乎兴趣」弹窗中可展开「检查知乎数据连接」。用户主动同意读取后，应用使用其服务端 OAuth 会话依次请求五项接口，每项 `Limit=1`。只存储状态、条数与时间，不导入检查读到的正文；可在页面下载结果，或由管理员在用户详情里查看。

收藏夹为空时，不请求不存在的收藏夹内容，按官方 Skill 记为空数据；授权失败或限流时停止后续请求，并明确标记剩余项目尚未检查。检查与导入共用 5 RPM，页面显示再次检查所需的等待时间。清除导入同时清除检查记录。

入口的协议、授权、空数据、异常、并发撤销和响应隐私已经通过隔离自动化。2026-09-13 13:52（Asia/Shanghai），用户亲自完成五项检查；随后用户提供的逐项结果与生产数据库保存的报告一致，真实 OAuth 用户数据验收通过。

## 正式应用中的配置

`hackathon.config.json` 只保存项目名、App ID 和公网回调。App Key 与 Access Secret 在 `/etc/soulmatch/` 的独立 `0600` 文件内，通过 systemd `LoadCredential` 注入应用，详见 [部署说明](DEPLOYMENT.md)。没有使用仅适用于 macOS 的钥匙串脚本；Linux 服务器使用 Skill 允许的部署凭证分支。

平台登记与应用配置必须使用同一个地址：

```text
https://zhihupipei.aiimage.icu/auth/callback
```

该入口将参数交给既有 `/api/auth/zhihu/callback` 处理，后者绑定当前浏览器、当前会话、一次性 state 和十分钟时限。`authorization_code` 与 `code` 均兼容。认证码和 Token 不写入日志或验证报告。

## 本人授权与用户接口验证

用户已经在自己的浏览器完成「连接知乎」并确认登录成功，满足官方 Skill 的要求：“用户必须亲自点击知乎授权页的最终确认按钮。”测试浏览器只验证官方登录入口，未代点确认；其 `authorized: false` 与正式用户的成功登录分别记录，不相互替代。

2026-09-13 13:52:22（Asia/Shanghai；UTC `2026-09-13T05:52:22.869Z`），五项 OAuth 用户接口真实验收通过。用户本人提供的 13:52 结果与运行服务所用生产数据库中的报告逐项一致。每项请求 `Limit=1`，本次五项均实际请求；仅读取报告元数据核对，没有提取浏览器会话、代替用户授权或重新调用知乎接口。记录见 [本人验收报告](../artifacts/zhihu-user-acceptance.json)。

| 用户接口 | 公网实测与复核结果 |
| --- | --- |
| 创作 | 成功，返回 1 条 |
| 关注 | 成功，返回 1 条 |
| 收藏夹 | 成功，返回 1 条 |
| 收藏夹内容 | 接口正常，返回 0 条；本次已取得收藏夹并实际请求其内容 |
| 近期收藏 | 接口正常，返回 0 条 |

官方资料记录过回调缺少 state 的协议偏差。本应用保持严格校验，缺失或不匹配会拒绝登录。账号基础信息采用当前官方基础信息文档中的字段，不把猜测出的身份写入账号记录。

## 清理

仅在用户明确要求时停止参考服务并移除参考项目或安装的 Skill。正式服务和凭证用于当前网站，不随参考项目的临时清理一起删除；若要下线作品，按部署文档逐项处理。
