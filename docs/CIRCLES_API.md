# 问题小组 API

实现契约：`createCircles({store,ai,zhihu,rate,emit,broadcast,assertSession,moderate,connect,notify})`，导出自 `server/circles/index.js`，返回 `{router,close,exportUser,deleteUser,canConnect,recommendations,profileEvidence}`。主应用挂载 `/api/circles`，统一处理会话、CSRF 和错误；本模块重复检查成员与主持权限。DTO 见 `shared/circles-types.ts`，以下响应不再嵌套 `data`。

所有时间为 ISO 字符串。身份 ID 保留字符串。昵称使用站内画像昵称或匿名名称，不展示知乎原头像、provider、邮箱或导入内容。非成员只获得小组概要；详情中的讨论、历史轮次、成员、资料和成果数组为空。

## 发现、推荐与加入

| 方法与相对路径 | 请求 | 响应 |
| --- | --- | --- |
| GET `/` | `q` 可选关键词；`mine=1` 只查已加入；`questionUrl` 可选知乎问题链接 | `{circles: CircleSummary[]}` |
| GET `/recommendations` | `q,goal,stage` 均可选 | `CircleRecommendations` |
| POST `/` | `{title,question,goal,description?,questionUrl?,tags?,capacity?,duration?,aiConsent?,subscribed?,allowConnections?}` | `201 {circle: CircleDetail}`，创建者成为主持 |
| GET `/:id` | `roundId` 可选，默认本轮 | `{circle: CircleDetail}` |
| POST `/:id/join` | `{duration?:'24h'|'7d'|'ongoing',goal?,stage?,subscribed?,allowConnections?,aiConsent?}` | `{circle: CircleDetail}` |
| PATCH `/:id/membership` | 同加入的可选字段 | `{circle: CircleDetail}` |
| POST `/:id/leave` | `{}` | `{circle: CircleDetail}`，返回公开概要 |
| POST `/:id/read` | `{roundId?,messageId?}`；省略 messageId 标记该轮当前末尾 | `{ok:true,unreadCount}` |
| PATCH `/:id` | 主持：`{aiEnabled?,autoSummary?,capacity?}` | `{circle: CircleDetail}` |

创建字段：title 2–100 字，question 5–500 字，goal 2–500 字，description 最多 1200 字，tags 最多 8 个、各 24 字，capacity 2–30（默认 12）。不自动种入虚拟小组或用户。允许同一知乎问题对应不同目标的小组；页面可先搜索相同问题。

知乎问题 URL 接受 HTTPS 的 zhihu.com/www.zhihu.com/m.zhihu.com 的 `/question/<数字>` 和其 `/answer/<数字>`，保留无损 questionId，规范成 `https://www.zhihu.com/question/<id>`；拒绝其他主机、凭据和端口。不请求该 URL，不抓取全文。

推荐是本地问题、目标与用户已确认兴趣的相关性排序，`mode:'rules'`；不调用模型或重新读取知乎。没有画像仍可按 q/goal/stage 推荐，`profileUsed:false`；没有候选时返回空数组及说明，不伪造人数。

duration 默认 ongoing，24h/7d 从本次明确加入或续期时计算。aiConsent、allowConnections 默认 false；subscribed 默认 true。进入小组本身不构成外部 AI 或私聊授权。aiConsent 控制本人发言是否可发送给外部 AI；无授权时仍可使用本地规则摘录。退出/过期立即失去成员读取权限、停止提醒；主持转交给最早的有效成员。个人导出仅包含本人的参与与发言。

## 轮次与消息

| 方法与相对路径 | 请求 | 响应 |
| --- | --- | --- |
| PATCH `/:id/rounds/:roundId` | 主持：`{status: CirclePhase}` | `{circle: CircleDetail}` |
| POST `/:id/rounds` | 主持：`{question,goal}` | `201 {circle: CircleDetail}` |
| GET `/:id/messages` | `roundId?,before?`，before 是消息 ID | `{messages,hasMore,nextBefore}` |
| POST `/:id/messages` | `{text,replyTo?,clientMessageId}`，text 1–4000 字，clientMessageId 8–100 字 | `201 {message,deduplicated}`；重试相同内容返回 200 |
| POST `/:id/messages/:messageId/hide` | 主持：`{}` | `{ok:true}` |
| DELETE `/:id/messages/:messageId` | 本人或主持 | `{ok:true}` |

轮次状态：recruiting → discussing；discussing → reviewing；reviewing → completed；completed → archived。主持可将活动轮次设为 dormant，再恢复 discussing；允许从 reviewing 返回 discussing，也可提前 archived。只有 completed/archived 之后才能开新轮；旧轮问题、目标及讨论不覆盖，新轮 number 递增。旧轮只读。超过 7 天无真人发言的活动轮次可进入 dormant，休眠不表示已解决。

仅本轮 recruiting/discussing/reviewing 可发言；首条真人发言将 recruiting 改为 discussing。回复必须指向同轮可见消息。消息发送调用统一 moderate，外部等待前后复查会话、成员、轮次及回复权限。相同重试键不同内容返回 409。

## 资料、主持与成果

| 方法与相对路径 | 请求 | 响应 |
| --- | --- | --- |
| GET `/:id/search` | `q` 2–200 字 | `{items:CircleSearchItem[],notice}` |
| POST `/:id/sources` | 手动 `{title,url,author?,summary?,scope?:'link'|'excerpt'}` 或 `{searchResultToken}` | `201 {source}` |
| DELETE `/:id/sources/:sourceId` | 本人或主持 | `{ok:true}` |
| POST `/:id/ai` | `{action:'opener'|'summary'|'outcome',useAI?:boolean}` | `CircleAIResult` |
| POST `/:id/outcomes` | `{title,content,messageIds?,sourceIds?}` | `201 {outcome}` |
| PATCH `/:id/outcomes/:outcomeId` | `{version,title?,content?,status?:'draft'|'reviewed'}` | `{outcome}`；版本冲突 409 |
| GET `/:id/outcomes/:outcomeId/versions` | 无 | `{versions:CircleOutcome[]}` |
| GET `/:id/outcomes/:outcomeId/export` | 无 | Markdown 下载；客户端 fetch 后下载 blob |

搜索结果 token 绑定用户、小组和轮次，15 分钟有效、使用一次。官方来源字段由服务端保存的结果生成，不信任客户端伪造的 scope/摘要。手动填写 summary 时只能是 excerpt；link 不代表读取过正文。资料删除后依赖它的 AI 输出和成果整体不可见。

AI 全部使用注入的 `ai.json(system,payload)`，不自建模型客户端或预算。每次最多 50 条可见真人消息和 12 条资料；外部调用仅包含作者明确同意 AI 处理的消息及资料。引用 ID、编号和引用原文由服务器校验。保存全部输入消息/资料依赖及授权版本，不只保存实际引用；隐藏、屏蔽、删除或撤回 AI 授权后输出必须重新整理，不能通过编辑、历史版本或导出绕过。

模型不可用、格式错误或引用不存在时给出明确 notice，降级为本地摘录，`mode:'rules'`；不伪造共识。成果 `reviewed` 只表示 reviewedBy 指定成员核对，非全员共识。每次编辑保存独立版本；修改正文默认重新成为 draft。

人工主持同一小组间隔至少 30 秒。autoSummary 默认关闭；主持开启后，当前轮新增至少 20 条真人发言且距上次至少 30 分钟才触发。按成员授权及屏蔽组装主持上下文，输出读取时按查看者检查权限。自动任务使用数据库租约和进度；重启可继续检查，close() 停止 timer 和未完成任务写回。加入时不会自动刷欢迎消息。

## 屏蔽、举报与自愿连接

| 方法与相对路径 | 请求 | 响应 |
| --- | --- | --- |
| POST `/:id/blocks` | `{targetId}` | `{ok:true}` |
| DELETE `/:id/blocks/:targetId` | 无 | `{ok:true}` |
| POST `/:id/reports` | `{messageId,reason}`，reason 2–1000 字 | `201 {reportId}` |
| GET `/:id/reports` | 主持 | `{reports:CircleReport[]}` |
| POST `/:id/reports/:reportId/resolve` | 主持：`{action:'hide'|'dismiss'}` | `{ok:true}` |
| POST `/:id/connect` | `{targetId,message}`，message 2–500 字 | `{connection,notice}` |

小组屏蔽有方向，隐藏查看者屏蔽的发言及资料，不剔除成员。全站既有单向屏蔽也参与群内可见性计算。连接阻断检查任意方向的全站/本组屏蔽；两人都须有效成员、明确 allowConnections，发送邀请后还须双方确认。无需开启全站发现。站内提醒只发给仍有效且订阅的成员；不包含消息正文或私密摘录。

## 主应用集成

`recommendations(userId,input={q,goal,stage})` 同步返回推荐 DTO。`canConnect(userId,targetId,circleId)` 同步返回 boolean，含成员、双方许可与屏蔽检查。`exportUser(userId)` 返回本人内容；`deleteUser(userId)` 在主应用删除 users 行之前调用，擦除本人发言、资料及依赖它的派生成果，转交主持。

`profileEvidence(userId,circleId,messageIds)` 只返回当前有效成员自己编写、当前可见的真人发言 `[{id,text}]`，不附带他人的回复预览。主应用另行检查聊天分析授权，并在外部 await 后重新取证比较。

`emit(userId,'circles')` 仅传变更通知；`broadcast('circles')` 仅用于公开概要变化。`notify(userId,{kind,title,body,href})` 由主应用持久化，href 使用 `/#circles/<id>`。assertSession(req) 必须同步抛错表示失效，或返回可 await 的检查；moderate 必须明确 allowed:true 才投递新真人发言。模块不把 AI 文本作为用户消息发送。
