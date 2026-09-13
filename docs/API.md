# 同知 API 与页面路由

本文记录当前主界面的接口与授权边界。接口定义以 `server/app.js` 及其挂载模块为准；小组完整字段与生命周期见 [CIRCLES_API.md](CIRCLES_API.md)，数据处理说明见 [PRIVACY.md](PRIVACY.md)。

## 页面入口

| 路由 | 页面 |
| --- | --- |
| `/#discover` | 发现问题，默认入口 |
| `/#my-circles` | 我加入的问题小组 |
| `/#circles/<id>` | 指定小组；打开页面不会自动加入 |
| `/#matching` | 异步知识伙伴匹配 |
| `/#profile` | 知识画像、报告、历史及待确认建议 |
| `/#connections`、`/#connections/<id>` | 交流邀请与指定私聊 |
| `/#notifications` | 站内通知 |
| `/#account` | 邮箱账号、偏好、处理记录及申诉 |
| `/#companion` | 明确标注为 AI 的知识伙伴与自我对话 |
| `/admin` | 独立管理员登录及治理后台 |

兼容旧链接：`#pairing` 转到匹配，`#graph`、`#knowledge` 转到画像；`#connections?conversation=<id>` 可打开指定对话。主界面不将体验人物当作真实用户。

## 通用约定

- 以下接口均以 `/api` 为前缀。业务响应直接返回 JSON 对象；错误为 `{error:{code,message}}`。常见状态为 400 参数错误、401 会话失效、403 无权限或缺少授权、404 资源不可访问、409 版本或状态冲突、422 内容待复核、429 限流。
- 先请求 `GET /bootstrap` 建立或读取访客会话，取得 `csrf`。保留 HttpOnly 的 `tongzhi_session` Cookie，写请求携带 `x-csrf-token`，正文使用 JSON 对象。服务端检查来源、会话及资源权限；知道 ID 不代表有读取权。
- 登录、注册和改密码会轮换会话与 CSRF；客户端应刷新 `/bootstrap`。`GET /health` 不需要会话；OAuth 回调另行校验 state 和发起授权的浏览器。
- `GET /events` 是当前用户的 SSE 变更提示，不传聊天正文。客户端收到提示后重新读取有权限的接口。
- 画像与偏好使用 `revision` 防止并发覆盖；涉及外部请求的主要流程在保存前再次核对会话、授权和材料版本。模型不可用时以 `mode:'rules'` 及 `notice` 明示规则结果。
- 同一服务进程内，AI 功能共享每分钟最多五次、并发最多两个外部模型请求的预算；内容审核也计入。知乎业务 API 另有每分钟最多五次的共享上限。429 后进入冷却，缓存命中无需再次请求；这不是每位用户各自五次。

## 身份、偏好与知乎授权

| 方法与路径 | 请求或结果 |
| --- | --- |
| `GET /account` | 本人站内昵称、身份类型、邮箱、`hasPassword`、`emailVerified` |
| `POST /auth/email/register` | `{email,password,name}`；为当前访客注册，或为当前知乎身份绑定邮箱，返回 201 |
| `POST /auth/email/login` | `{email,password}`；登录既有邮箱账号 |
| `POST /auth/email/password` | `{currentPassword,newPassword}`；撤销所有旧会话，再签发当前会话 |
| `GET /preferences` | `{preferences,revision,updatedAt}` |
| `PUT /preferences` | `{revision,preferences:{...布尔字段}}`；可只提交变更项 |
| `POST /auth/zhihu/start` | `{}`，取得授权跳转 `url` |
| `GET /auth/zhihu/callback` | 校验 OAuth 回调；`/auth/callback` 转发至此 |
| `GET /zhihu/validation`、`POST /zhihu/validation` | 查看检测报告；检测需 `{consent:true}`，五类检查各最多一条 |
| `POST /zhihu/import` | `{sources:['contents','followees','collections'],useAI?:boolean}`；可选择其中一至三类 |
| `DELETE /zhihu/import` | 清除导入、相关历史与建议，忘记本服务内的知乎令牌，按本人填写内容重建画像 |

邮箱按规范化值唯一绑定，密码保存为加盐 scrypt 哈希。**当前没有邮箱验证或邮件找回流程，绑定成功不代表已验证邮箱归属。** 不按昵称猜测或合并身份。

偏好默认值：`groupInvites:true`、`aiAnalysis:false`、`chatAnalysis:false`、`notificationDigests:true`。小组成员的 `aiConsent`、`allowConnections` 另行授权，默认关闭。`notificationDigests` 当前保存摘要偏好；通知生产逻辑仍会写入站内提醒，尚无独立定时摘要投递器。

知乎登录只建立身份连接，不自动导入内容。每次所选导入类型最多十条，保存标题、摘要或关注者简介及链接；搜索结果同样只是摘要，不能表述为已读全文。

## 知识画像与本人发言建议

| 方法与路径 | 请求或结果 |
| --- | --- |
| `POST /profile` | `{input,revision,useAI?:boolean}`；生成或更新本人画像 |
| `POST /profile/visibility` | `{discoverable,revision}`；开启可发现性时校验最新版本 |
| `GET /knowledge/report` | 本人画像报告、材料覆盖说明与至多二十次画像历史 |
| `GET /knowledge/suggestions` | `{items,enabled}`；只返回仍有材料权限及有效授权的建议 |
| `POST /knowledge/suggestions` | `{sourceType:'conversation'\|'circle'\|'companion',sourceId,messageIds}`；显式选择 1–10 条本人发言 |
| `POST /knowledge/suggestions/:id/accept` | `{revision}`；确认合并兴趣标签，画像重新保持私有 |
| `POST /knowledge/suggestions/:id/dismiss` | `{}`；删除建议 |

`input` 包含站内昵称、3–8 个兴趣 `topicIds`、自述、当前问题、交流期待 `goals` 与方式 `styleId`。新建、更新及接受建议不自动公开画像。

生成本人发言建议要求单独开启 `chatAnalysis`；只有另开 `aiAnalysis` 才尝试将所选文本交给模型，否则本地提取标签。服务端检查消息作者、当前访问权和所选内容，过滤引用行，并在保存/接受时复查。关闭 `chatAnalysis` 清除建议。接受时仅将标签并入画像，不把私聊原句公开。**没有自动扫描私有聊天并更新画像的后台任务。**

## 异步匹配与私聊

| 方法与路径 | 请求或结果 |
| --- | --- |
| `GET /matching` | `{request,proposal,counts,conversationId,notice}` |
| `POST /matching/start` | `{revision,mode:'resonance'\|'complement',question?}` |
| `POST /matching/pause`、`/matching/resume`、`/matching/cancel` | `{requestId}` |
| `POST /matching/respond` | `{proposalId,decision:'accept'\|'decline'}` |
| `GET /connections` | 本人的收藏与交流邀请 |
| `POST /invitations` | `{targetId,message}`；旧人物卡邀请入口同样进行内容审核 |
| `POST /invitations/:id/respond` | `{action:'accept'\|'decline'}` |
| `GET /conversations/:id` | 已接受连接内的对方卡片及分页消息，支持 `before` |
| `POST /conversations/:id/messages` | `{text,clientMessageId?}`；最多 2000 字，推荐 UUID 重试键 |
| `GET /conversations/:id/context` | 规则话题、双方 `aiConsent`、有效缓存及 `autoGenerate` |
| `POST /conversations/:id/ai-consent` | `{enabled:boolean}`；只修改本人对该段对话的授权 |
| `POST /conversations/:id/icebreakers` | `{}`；双方同意后才能生成 AI 话题 |
| `GET /blocked`、`POST /blocked/:id`、`DELETE /blocked/:id` | 查看、添加、撤销全站屏蔽 |

匹配请求与提案存于 SQLite，运行中的服务约每 15 秒检查，关闭浏览器后仍继续，重启后可恢复。请求有效期七天；提案最多保留 48 小时且不超过请求期限。请求状态为 `searching/proposed/paused/cancelled/expired/fulfilled`；双方接受才建立私聊。暂停不延长期限，拒绝或提案失效后有效请求可继续寻找；画像、账号或屏蔽变化会使待确认条件失效。

主动发起匹配授权系统使用已确认画像卡片进行本地比较，并向提案双方展示匹配理由；不要求将画像开放给全站发现。停止异步匹配请使用暂停或取消接口。

**已建立私聊的 AI 破冰单独实行双方同意。** 默认先展示规则话题；双方同意且无有效缓存时，聊天页自动请求生成。发送给模型的是共享兴趣、本人问题、对方自述/问题/交流方式，以及最多三条知乎搜索摘要，不读取这段私聊的消息正文。撤回同意清除该对话缓存；授权或画像在请求中变化时不保存过期结果。话题只进入草稿，不自动代表用户发送。

旧 `/pairing/*` 和 `/matches` 等兼容入口不承担当前异步匹配主流程；新客户端应使用 `/matching`。旧 `/people/:id/explain` 与 `/people/:id/icebreakers` 对真人只返回本地规则，提示进入已连接对话授权，不调用模型或搜索。旧体验入口仅对明确虚构的 demo 人物保留模型/向量功能，当前主界面不请求；真人匹配采用本地兴趣计算。

## 问题小组与 AI 陪伴

小组统一位于 `/circles`：发现、推荐、显式加入/退出、轮次、消息、资料、AI 主持、成果版本、屏蔽、举报与自愿连接均见 [CIRCLES_API.md](CIRCLES_API.md)。非成员只读概要；成员及主持权限每次检查。小组邀请还要求双方成员允许连接及接收方全局邀请偏好，接受后才建立私聊。

小组 `aiConsent` 控制本人发言能否进入外部 AI 主持上下文。主持的自动摘要默认关闭。资料/发言被隐藏、删除、屏蔽或 AI 授权撤回时，依赖它们的输出、版本和导出随权限失效；不可访问成果导出返回 `409 outcome_redacted`。

| 方法与路径 | 请求或结果 |
| --- | --- |
| `GET /companion/sessions` | 本人 AI 会话列表 |
| `POST /companion/sessions` | `{mode:'self'\|'partner',consent:true}`；最多保留二十段 |
| `GET /companion/sessions/:id` | 本人会话与消息 |
| `POST /companion/sessions/:id/messages` | `{text,clientMessageId,consent:true}`；文本最多 2000 字 |
| `DELETE /companion/sessions/:id` | 删除该会话及关联建议 |

AI 陪伴向配置模型发送本人画像摘要、本次输入及该 AI 会话最近十二条消息；不读取其他私聊。偏好版本变化后需新建授权会话，响应保存前也复查画像版本。相同重试键和相同内容返回既有结果；不同内容返回冲突。

## 通知、复核与管理员

| 方法与路径 | 请求或结果 |
| --- | --- |
| `GET /notifications` | 最近一百条本人站内通知及未读总数 |
| `POST /notifications/read` | `{ids?:string[]}`；省略 ids 标记全部已读 |
| `GET /safety` | 本人的处理记录与当前有效限制 |
| `POST /safety/:id/appeal` | `{text}`；5–1000 字，只能申诉本人案件 |
| `POST /reports` | `{scope:'conversation',scopeId,messageId,reason}`；只能举报可访问对话中对方的真实发言 |

后台产生的通知持久保存在站内，SSE 只在页面连接时提示刷新；**没有 WebPush、系统通知或邮件送达功能**。小组提醒还检查成员有效性与该组订阅设置，提醒不附私密正文。

管理员使用独立 `tongzhi_admin` 会话：先 `GET /admin/session` 获取管理员 CSRF，再 `POST /admin/login {username,password}`；写操作携带管理员 CSRF。普通用户 Cookie 不能访问管理接口。

| 管理接口 | 用途与约束 |
| --- | --- |
| `GET /admin/overview`、`GET /admin/users`、`GET /admin/users/:id` | 注册统计、搜索及账号详情；邮箱搜索支持已绑定邮箱，列表/详情只显示邮箱掩码，不提供私聊正文 |
| `POST /admin/users/:id/status` | `{status:'active'\|'disabled',reason}`；停用撤销全部会话、隐藏画像并使匹配失效；恢复不复活旧会话 |
| `GET /admin/moderation?status=pending\|all` | 复核元数据列表，不附待审消息正文 |
| `POST /admin/moderation/:id/open` | `{reason}`；记录阅读审计后返回案件正文及该私聊最多四条、每条最多 700 字的上下文 |
| `POST /admin/moderation/:id/review` | `{action:'allow'\|'dismiss'\|'warn'\|'mute'\|'ban'}`；已处理案件重复操作返回 409 |
| `GET /admin/circle-reports` | 列出待处理小组举报及被举报文本摘要，并记录阅读审计 |
| `POST /admin/circle-reports/:id/resolve` | `{action:'hide'\|'dismiss'}`；记录处理审计，防止重复处理 |
| `POST /admin/logout` | 结束管理员会话 |

新私聊、小组消息及交流邀请均经过内容审核。模型已配置时，普通表达也尝试 AI 辅助判断，私聊附同一对话最近四条、每条最多 700 字的上下文，受共享五次/分钟预算约束。低风险内容遇模型超时、限流或不可用时按规则继续；显式风险内容仍暂缓投递，等待复核。高频重复内容也可暂缓投递，AI 不直接形成永久封禁。

禁言通常为 24 小时；申诉本身不解除限制。申诉通过或驳回对应举报仅撤销该案件处罚，其他案件继续生效；管理员明确恢复账号可撤销账号现有处罚。停用账号无法再用原会话进入站内申诉页，需要管理员处理恢复。

## 导出、退出与注销

| 方法与路径 | 行为 |
| --- | --- |
| `GET /account/export` | 下载 `tongzhi-my-data.json`，包含当前本人画像、导入、检测报告、收藏 ID、偏好、可见建议/通知、本人小组内容及 AI 会话 |
| `POST /logout` | 退出当前会话、将画像设为私有并忘记本服务内的知乎令牌；不会删除账号 |
| `DELETE /account` | `{confirm:'delete'}`；删除当前账号及关联私有数据，清除或匿名化本人小组内容和依赖成果 |

当前个人 JSON 导出不包含双人私聊全文、密码哈希或 OAuth 令牌。小组成果 Markdown 导出仍受当前成员和来源权限检查。注销保留必要的无正文治理/审计记录，不应描述为清除了所有运维副本。

原项目数据迁移采用**快照导入、独立数据库运行，无持续同步**。新站的后续修改、导出和注销只作用于新站数据；旧站、迁移源快照和运维备份有各自的数据生命周期。
