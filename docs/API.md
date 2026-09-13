# 同频后端 API

Node.js 22.13+、Express 5、SQLite。生产环境由同一个服务提供前端构建与 `/api`，监听地址默认 `127.0.0.1:3022`。

## 会话与错误

浏览器先请求 `GET /api/bootstrap`。首次请求创建独立访客身份与随机 `HttpOnly; SameSite=Lax` 会话 Cookie；配置 HTTPS `SOUL_PUBLIC_ORIGIN` 后自动添加 `Secure`。会话有效期 30 天，数据库仅保存会话令牌的 SHA-256 摘要。

所有更改数据的请求携带 `X-CSRF-Token: <bootstrap.csrf>`，正文使用 JSON 对象。服务校验请求来源；OAuth GET 回调独立校验原始会话、一次性 state 和浏览器 Cookie。成功登录轮换会话及 CSRF，前端应重新 bootstrap。业务 API 响应不缓存。

统一错误形状：`{"error":{"code":"profile_changed","message":"..."}}`。常见 HTTP 状态：400 输入无效、401 会话或授权失效、403 来源或 CSRF 不匹配、404 目标不可访问、409 版本或操作冲突、429 限流、503 对应能力未配置。429 返回 `Retry-After: 60`；知乎日配额不足时需等待额度恢复。

## 画像与匹配

| 方法与路径 | 输入 | 返回与行为 |
| --- | --- | --- |
| `GET /api/health` | 无 | `{status, app, version}`，不创建会话 |
| `GET /api/bootstrap` | 无 | `{user, csrf, profile, sampleProfile, capabilities, zhihuConnected, imports, savedIds, incomingCount}` |
| `POST /api/profile` | `{input, revision, useAI?}` | `{profile}`；初次 revision 为 0，更新必须带当前版本 |
| `POST /api/profile/visibility` | `{discoverable, revision?}` | `{profile}`；公开时必须带当前 revision |
| `GET /api/matches` | `pool=demo\|people`、`mode=resonance\|complement`、可选 `topic`、`q`、`saved=true` | `{matches, pool, mode, preview, total, algorithm, notice}` |
| `GET /api/people/:id` | 伙伴 ID | `{match}`；检查公开状态、已接受连接及双向屏蔽 |
| `POST /api/people/:id/explain` | 可选 `{mode:"resonance"\|"complement"}` | `{mode, reasons, bridge, notice?}`；返回的 mode 是 `model` 或 `rules` |
| `POST /api/people/:id/icebreakers` | 空对象 | `{mode, questions, sourceIds, sources, sourceNotice, notice?}` |
| `PUT /api/saved/:id` | `{saved}` | `{savedIds}`；可收藏体验人物 |

`input`：`name`（1–24 字符）、`topicIds`（3–8 个不同的目录 ID）、`about`（可选，最多 360 字符）、`question`（可选，最多 200 字符）、`styleId`、`goals`（1–3 个不同的目录 ID）。目录来自 `shared/catalog.js`，不接受未知值。`useAI` 默认 true，false 明确使用规则。

初次保存画像得到 revision 1；之后每次保存画像，或在已有画像时导入/清除知乎内容，都会把 revision 加 1，退出公开匹配并取消等待中的邀请。尚无画像时，导入/清除不会创建画像或增加版本，返回 `profile: null`。用户查看新内容后可用新 revision 再次公开。单独更改公开开关不增加 revision。409 时重新 bootstrap、让用户查看现有内容后再提交。退出匹配不会取消已接受连接，双方仍可查看伙伴与继续对话；屏蔽会撤销连接访问。

真实池最多读取 50 位已公开参与者，不注入体验人物；空池返回空数组。体验池的八位人物固定标记 `demo: true` 与 `provider: "demo"`。公开画像不返回原始导入证据或私有输入对象。未建立自己的画像时用明确的 sampleProfile 预览。

匹配指数不是关系成功概率。每个结果的 `breakdown` 包含百分制 `value` 与 `weight`，权重合计 100，显示分数严格等于 `round(sum(value × weight) / 100)`。同频模式综合知识领域、具体兴趣、交流节奏和期待；互补模式保留共同兴趣作为讨论起点，再衡量新视角。`algorithm` 明确标记当前使用的 `topics` 或 `embedding`。伙伴详情与连接列表使用可解释的主题计算；发现列表在可选向量服务成功时使用 embedding。

## 手动在线配对

发现页的推荐列表是浏览功能；在线配对必须由用户主动点击开始。只有已经生成画像、主动入队且持续在线的真实参与者才会成为候选，不从体验池补人。点击开始仅同意向本次配对的另一方临时展示公开画像字段，不会设置 `discoverable=true` 或让第三人查看私有画像。

| 方法与路径 | JSON 输入 | 行为 |
| --- | --- | --- |
| `GET /api/pairing` | 无 | 读取本人当前状态，不入队、不续在线时间；忽略第三人身份查询参数 |
| `POST /api/pairing/start` | `{revision, mode?, topic?}` | 以当前画像版本开始一轮；mode 默认为 `resonance`，可选 `complement` |
| `POST /api/pairing/heartbeat` | 可选 `{attemptId}` | 仅为当前仍有效的排队/候选状态续在线时间 |
| `POST /api/pairing/respond` | `{pairId, decision:"accept"\|"skip"}` | 确认对话或换一位；双方确认前不会创建聊天邀请 |
| `POST /api/pairing/cancel` | 可选 `{attemptId}` | 停止当前未完成的匹配；在已连接状态只收起结果，不删除已有对话 |

以上接口均返回相同结构，修改接口沿用本站会话、来源和 CSRF 校验：

```json
{
  "status": "idle | searching | proposed | connected",
  "attemptId": "本轮 UUID 或 null",
  "mode": "resonance | complement",
  "topic": null,
  "expiresAt": null,
  "heartbeatExpiresAt": null,
  "pair": null,
  "conversationId": null,
  "reason": null,
  "notice": null
}
```

`pair` 非空时为 `{id, person, acceptedByMe, acceptedByOther}`。`person` 是完整的 Match（含 `saved`、`reasons`、`breakdown`），只包含当次另一方，不包含原始导入依据、第三人或队列名单。候选页面可直接展示该对象，普通 `/api/people/:id` 不因排队而开放私密画像。私密候选的屏蔽操作额外允许当前相互配对的双方使用原 `/api/blocked/:id`。

`searching` 的 `expiresAt` 是本轮开始后三分钟；`proposed` 时是候选产生后六十秒。两种状态都要求每 8–12 秒调用心跳，连续 45 秒未收到则退出。GET 不续期，迟到心跳也不会重新入队；用户需再次主动开始。定时清理默认每五秒运行，所有状态请求同时检查准确截止时间。确认超时或对方离开后，仍在线的一方可在原三分钟期限内继续寻找；原期限已结束则回到 idle。

进行中的相同 start 幂等，不刷新三分钟期限；更换 mode/topic 返回 409 `pairing_active`，需要先取消。topic 接受目录中的兴趣 ID，`null`、省略、空字符串或 `all` 表示不限；候选必须同时满足双方各自的筛选。优先处理较早入队者，再从合格候选中选择双方各自模式下平均指数更高的人。在线配对使用主题计算，不调用模型或 embedding。

双方点击 accept 后，后端在事务内创建一条既有邀请结构的 accepted 连接，`conversationId` 可直接用于原聊天接口。相同确认重试返回同一连接。skip 让双方继续排队；skip、取消、掉线及确认超时都会让这对人避让五分钟，避免马上再次相遇。仍在短期缓存中的旧 pairId，其迟到重试只返回本人的最新状态，不操作新的候选；他人、未知或缓存已清除的 pairId 返回 404。已接受连接、已有待处理邀请及双向屏蔽的两人不能再次配为候选。

客户端应在 heartbeat/cancel 中携带收到的 `attemptId`；与当前轮次不符时只返回当前状态，不续在线或取消新轮次。离开页面时停止心跳即可，避免卸载请求取消另一标签页新开的轮次。每人同一时刻只能有一组候选；换人和确认都是同步状态转移，不会同时分配给多人。

退出登录、切换身份、删除账号、开始重建/导入/清除画像以及主动退出发现会立即撤销未完成配对。屏蔽会结束对应候选或已建连接的访问。已接受聊天保存在 SQLite；排队、候选与十分钟内的幂等结果只在单进程内存保存，服务重启后要主动重新开始。新 start 可以覆盖本人已连接的展示状态，已有聊天继续保留。

状态改变向相关两方发送 SSE `pairing` 和 `changed`，事件数据固定为 `{}`，前端再读取本人状态。无相应画像返回 400 `profile_required`，版本过期返回 409 `profile_changed`，画像正在更新返回 409 `profile_busy`，无权或未知配对返回 404 `pairing_missing`。`reason` 的 idle 原因包括 `cancelled`、`offline`、`queue_expired`、`profile_changed`、`account_changed`、`blocked`、`person_unavailable`；继续排队的原因包括 `skipped`、`peer_skipped`、`peer_left`、`proposal_expired`、`pair_unavailable`。notice 提供可直接展示的中文说明。

每用户 start 每分钟最多 12 次，heartbeat/respond 各最多 30 次。单进程最多容纳 200 位进行中的参与者，满员返回 429 `pairing_full`。自动化测试可通过 `createApp(config, {pairingOptions:{now, offlineMs, queueMs, proposalMs, sweepMs}})` 注入时钟与期限，生产环境不提供修改时间的 HTTP 接口。

## 邀请、对话与屏蔽

| 方法与路径 | 输入 | 返回与行为 |
| --- | --- | --- |
| `GET /api/connections` | 无 | `{saved, invitations}`；邀请含 `id, direction, status, message, person, lastMessage` |
| `POST /api/invitations` | `{targetId, message}`，消息 2–500 字符 | `201 {id}`；双方需在真实匹配池，体验人物不能邀请 |
| `POST /api/invitations/:id/respond` | `{action:"accept"\|"decline"}` | `{ok:true}`；仅接收人可处理一次待处理邀请 |
| `GET /api/conversations/:id` | 可选 `before=<消息ID>` | `{person, invitation, items, hasMore, nextBefore}`；每页最多 100 条，页内按发送顺序排列 |
| `POST /api/conversations/:id/messages` | `{text, clientMessageId?}`，正文 1–2000 字符 | `201 {id, authorId, text, createdAt}`；仅已接受连接中的本人可发送 |
| `POST /api/blocked/:id` | 空对象 | `{ok:true}`；取消双方邀请/连接、删除双向收藏、阻止画像与对话访问 |
| `GET /api/blocked` | 无 | `{people:[{id,name}]}` |
| `DELETE /api/blocked/:id` | 空对象 | `{ok:true}`；不会自动恢复旧邀请或聊天授权 |

`clientMessageId` 是可选 UUID，建议浏览器使用 `crypto.randomUUID()`。按作者、会话及此 ID 保证唯一；同一正文的网络重试返回原消息，同一 ID 搭配不同正文返回 409 `client_message_conflict`。前端在失败重试时保留 ID，编辑正文或发送成功后生成新 ID。省略此字段兼容旧客户端。SQLite 启动时自动迁移既有消息表，重启后仍能去重。

## 知乎连接与个人数据

| 方法与路径 | 输入 | 返回与行为 |
| --- | --- | --- |
| `POST /api/auth/zhihu/start` | 空对象 | `{url}`；由浏览器跳转到知乎完成本人授权 |
| `GET /auth/callback` | OAuth 原始 Query | `302` 原样转发 Query 至下方内部回调，兼容赛事生成器要求的路径后缀 |
| `GET /api/auth/zhihu/callback` | `state` 和 `authorization_code` 或 `code` | 跳回 `/?auth=success\|failed\|state_error\|cancelled#profile` |
| `POST /api/zhihu/import` | `{sources:["contents"\|"followees"\|"collections"], useAI?}` | `{count, counts, profile}`；仅用户主动勾选的来源，每类最多 10 项 |
| `DELETE /api/zhihu/import` | 空对象 | `{profile}`；清除导入、重新构建画像并清除当前 OAuth Token |
| `GET /api/account/export` | 无 | JSON 附件，含当前用户、画像、导入和收藏 |
| `POST /api/logout` | 空对象 | `{ok:true}`；退出匹配、结束会话、清除 OAuth Token 与内存 AI 缓存 |
| `DELETE /api/account` | `{confirm:"delete"}` | `{ok:true}`；删除该用户及会话、画像、导入、收藏、屏蔽、邀请、消息等关联记录 |
| `GET /api/events` | EventSource 携带 Cookie | SSE 事件 `changed`、`pool`，25 秒心跳；用于触发界面刷新 |

OAuth state 十分钟有效且只能使用一次。`/access_token` 使用表单交换，`/user` 仅发送用户 OAuth Bearer Token；创作摘要、关注及收藏列表同时发送应用 Access Secret、用户 `X-OAuth-Token` 和秒级时间戳。大整数 uid 从 JSON 解析开始无损保留，未获取有效身份时不创建登录身份。

赛事登记可使用 `https://zhihupipei.aiimage.icu/auth/callback`。公开入口不交换 Token、不放宽 state 校验、不记录 Query，只作不可缓存的本站跳转；浏览器到达 `/api/auth/zhihu/callback` 后仍需原会话、一次性 state 和 `/api/auth/zhihu` 路径下的 OAuth Cookie。缺失或不匹配继续返回 `state_error`。

OAuth Token 保存在服务端内存中，进程重启后需重新连接；不会下发到前端。Token 过期或鉴权错误时停止数据读取，保留已有应用身份，不退回应用开发者本人数据。请求频率或配额错误不撤销用户身份。搜索引用仅使用知乎返回的标题、摘要和官方 HTTPS 链接，不将摘要当全文。

每次成功导入以本次勾选来源的结果覆盖上次导入，不累积历史。`collections` 对应近期收藏内容，不遍历全部收藏夹或完整收藏历史。导出接口只包含表中列出的用户资料、画像、导入和收藏，不包含聊天记录。

## 模型与限制

文本模型使用服务端 `SOUL_AI_BASE_URL`、`SOUL_AI_API_KEY`、`SOUL_AI_MODEL`。兼容根域名、`/v1` 或完整 `/chat/completions` 地址。当前验证过的组合是 `deepseek-v4-flash`、`SOUL_AI_JSON_MODE=true`、`SOUL_AI_DISABLE_THINKING=true`。JSON 模式默认启用；关闭思考默认关闭，通过环境变量按供应商支持情况启用。Anthropic Messages 协议使用自己的请求字段。

仅配置文本模型不会启用语义向量；需单独提供真实的 `SOUL_EMBEDDING_MODEL`，其余 embedding URL/key 可单独配置或复用文本配置。若文本地址已包含 `/chat/completions`，向量需另设 `SOUL_EMBEDDING_BASE_URL`（例如以 `/v1` 结尾的基础地址）。批量向量按文本去重，在并发请求之间复用进行中的调用，并验证索引、维数、非零有限向量。未配置或失败时明确回退主题计算，不伪装成 embedding。

文本与向量共用每分钟最多 5 次外部调用、最多 2 个并发请求。相同文本结果进行短期缓存，重复并发生成只调用一次。模型不合约、引用不存在、URL 编造、超时或服务故障都回到有说明的规则结果；输出检查不修改分数，也不替用户发送消息。清除缓存后，进行中的旧请求不会重新填入已清除内容。

本地接口另有按身份的限流：画像 8 次/分钟、邀请 5 次/分钟、聊天 30 次/分钟、解释 15 次/分钟、破冰 12 次/分钟、导入 3 次/分钟。知乎业务请求每分钟最多 5 次，缓存与正在进行的相同请求不重复消耗调用。单进程内存限流和 SQLite 适合当前参赛部署；多实例部署需要共享限流、OAuth Token 与事件通道。
