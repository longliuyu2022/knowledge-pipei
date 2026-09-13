# 管理后台 API

管理入口为 `/admin`，接口前缀为 `/api/admin`。管理员账号由服务器配置，与普通游客会话、知乎授权和用户身份分开。管理接口不会创建游客、修改用户最近访问时间、读取 OAuth 令牌或推进在线匹配队列。

部署和密码初始化见 [ADMIN.md](./ADMIN.md)。实现位于 `server/admin.js`，接口与安全测试位于 `tests/admin.test.js`。

## 认证与请求规则

- `SOUL_ADMIN_USERNAME` 默认为 `admin`，允许 3–64 个 ASCII 字母、数字、点、下划线和短横线。
- `SOUL_ADMIN_PASSWORD_HASH` 支持直接配置、对应的 `_FILE` 文件或 systemd credential。只能使用初始化工具生成的 scrypt 哈希；不接受明文密码、未知格式、非标准编码或降低后的计算参数。
- `hashAdminPassword(password)` 是异步初始化函数，接受 12–256 个字符。密码不去除首尾空格。当前编码为 `scrypt$32768$8$1$<base64url salt>$<base64url digest>`，使用 16 字节随机盐和 64 字节派生结果。
- 管理 Cookie 名为 `soul_admin`，设置 `HttpOnly`、`SameSite=Strict`、`Path=/api/admin`；HTTPS 部署时设置 `Secure`。它不携带普通用户身份。
- 会话只保存在服务内存中，服务重启后失效。认证会话绝对有效期为 8 小时，读取或刷新页面不会续期。匿名登录凭证有效期为 15 分钟。
- 登录成功轮换 Cookie 和 CSRF，旧凭证立即失效。退出登录立即销毁原会话，并返回新的匿名登录状态。
- 所有响应设置 `Cache-Control: no-store`。所有提供的 `Origin` 必须匹配服务器允许来源；写请求必须提供有效 `Origin`。提供 `Sec-Fetch-Site` 时只接受 `same-origin` 或 `none`，拒绝 `same-site`、`cross-site` 及未知值。
- 登录、退出均要求有效管理 Cookie 和 `X-CSRF-Token`。先读取 `/session` 获得登录 CSRF。普通 API 的 CSRF 或 Cookie 不能替代管理凭证。
- 登录失败按 IP 限制为 15 分钟内 5 次，第 6 次返回 429；服务全局上限为 15 分钟内 50 次失败，同时最多进行 2 次密码派生检查。用户名或密码错误使用相同的 401 响应。429 带 `Retry-After` 秒数。
- 匿名登录凭证按 IP 限制为 15 分钟内 30 次签发；会话及限流存储有容量上限，并定期清理过期记录。正常 `/session` 读取复用已有凭证。

## 会话接口

### `GET /session`

返回当前管理状态。未登录且已配置时创建匿名登录凭证。未配置或哈希无效时返回 `configured: false`，不签发凭证。

### `POST /login`

JSON 请求体：

```ts
{ username: string; password: string }
```

请求用户名最多 64 个字符，密码最多 256 个字符，均不能为空。成功返回新认证会话；无效凭据返回通用错误，不暴露配置的用户名或哈希。

### `POST /logout`

可以省略请求体或传 `{}`。需要管理 CSRF，成功后所有共享原 Cookie 的标签页均失去认证。

以上三个接口的成功响应结构相同：

```ts
{
  configured: boolean;
  authenticated: boolean;
  username: string | null; // 仅认证成功时提供管理员用户名
  csrf: string | null;
  expiresAt: string | null; // 当前凭证的绝对过期时间，ISO 8601
}
```

## 总览

### `GET /overview`

要求管理员认证，直接返回以下对象，没有额外包装层：

```ts
{
  generatedAt: string;
  counts: {
    totalUsers: number;
    zhihuUsers: number;
    guestUsers: number;
    profileUsers: number;
    discoverableUsers: number;
    onlineUsers: number;
    newUsersToday: number;
    connections: number;
    messages: number;
  };
  pairing: { searching: number; proposed: number };
  interests: { id: string; label: string; count: number }[];
  registrations: { date: string; zhihu: number; guest: number }[];
}
```

统计口径：

- 总用户包含游客及知乎账号；已生成画像和已公开画像分别计数。演示角色没有写入用户表，不计入这些统计。
- 今日新增及 `registrations` 均按 `users.created_at` 的 **Asia/Shanghai（UTC+8）首次加入日期** 计算。`registrations` 连续返回最近 7 个自然日，缺失日期填 0，按当前账号来源划分游客及知乎账号。游客后来授权知乎时，其首次加入日期不改变。
- `registeredAt` 是首次知乎 OAuth 授权时间，用于用户字段展示，不用于加入趋势。历史记录未知时保留 `null`。
- 在线人数仅统计当前存在 SSE 连接的实际用户。最近访问时间不用于推测在线状态，同一用户的多个连接只算一次。
- `pairing.searching` 和 `pairing.proposed` 均为人数，来自现有匹配状态快照；查询不触发匹配、清队列或状态切换。
- 兴趣统计包含公开和私密画像，按用户去重；同一画像重复出现某兴趣只算一次。只返回计数大于 0 的已知兴趣，并按人数降序排列。
- `connections` 为状态 `accepted` 的连接记录数；`messages` 为消息记录总数，均不返回内容。

## 用户列表

### `GET /users`

所有条件可组合，默认包含游客和知乎账号：

| 参数 | 默认值 | 有效值与含义 |
| --- | --- | --- |
| `q` | 空 | 最多 100 个字符；搜索昵称、用户 ID、画像标题、兴趣 ID 和名称；去除首尾空白 |
| `provider` | `all` | `all`、`zhihu`、`guest` |
| `profile` | `all` | `all`、`ready`（已有画像）、`empty`（无画像） |
| `visibility` | `all` | `all`、`public`（公开画像）、`private`（未公开，包含无画像账号） |
| `topic` | `all` | `all` 或 `shared/catalog.js` 中的兴趣 ID |
| `page` | `1` | 1–1,000,000 的整数 |
| `pageSize` | `20` | 1–100 的整数 |

搜索使用绑定参数，`%`、`_` 和反斜线按字面匹配，不作为 SQL 通配符。非法枚举、重复参数或非法分页返回 400。

结果按首次加入时间倒序、用户 ID 倒序稳定排序。超出最后一页时返回空 `items`；`totalPages` 最低为 1。

```ts
{
  items: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

type AdminUserRow = {
  id: string;
  name: string;
  avatar: string;
  provider: string;
  createdAt: string;
  registeredAt: string | null;
  lastSeenAt: string | null;
  online: boolean;
  profile: null | {
    title: string;
    interests: { id: string; label: string }[];
    discoverable: boolean;
    analysisMode: 'model' | 'rules';
    updatedAt: string;
  };
  pairingStatus: 'idle' | 'searching' | 'proposed' | 'connected';
};
```

## 用户详情

### `GET /users/:id`

管理员可查看实际存在的公开或私密画像，不需要切换到该用户身份。找不到用户返回 404。

```ts
{
  user: AdminUserRow;
  profile: null | {
    title: string;
    summary: string;
    highlights: string[];
    interests: { id: string; label: string }[];
    dimensions: { id: string; label: string; color: string; value: number }[];
    style: { id: string; label: string; values: number[] };
    goals: string[];
    about: string;
    question: string;
    analysisMode: 'model' | 'rules';
    revision: number;
    discoverable: boolean;
    updatedAt: string;
  };
  zhihuValidation: null | {
    checkedAt: string;
    status: 'passed' | 'partial' | 'failed';
    items: { id: string; label: string; status: 'success' | 'empty' | 'error' | 'skipped'; count: number | null; code: string | null; message: string }[];
  };
  activity: {
    connections: number;
    pendingInvitations: number;
    messages: number;
    saved: number;
    importedItems: number;
    importedAt: string | null;
  };
}
```

活动计数中，连接和待处理邀请包含收发双方；消息只统计该用户发送的记录，收藏只统计该用户收藏的记录。导入数据只返回数量及更新时间。`zhihuValidation` 仅为用户主动运行的五项数据检查结果，包含状态、条数和时间，不包含检查读取的内容。未做过检查为 null，后台查看不会代替用户发起检查。

响应使用明确字段白名单，并在 SQL 中仅投影需要的画像字段。不返回 OAuth subject、普通或管理员会话材料、密码或哈希、完整 `input`、画像 `evidence`、原始导入内容、邀请正文或聊天正文。此版本没有删除、修改账号、代登录、导出用户原始数据等管理接口。

## 错误

错误统一为：

```ts
{ error: { code: string; message: string } }
```

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `admin_invalid_input` | 登录请求体或字段无效 |
| 400 | `admin_invalid_filter` | 用户筛选或分页参数无效 |
| 401 | `admin_auth_required` | 未登录或管理会话已失效 |
| 401 | `admin_invalid_credentials` | 用户名或密码错误 |
| 403 | `admin_origin_mismatch` | 请求来源未通过验证 |
| 403 | `admin_csrf_mismatch` | 管理 CSRF、Cookie 或并发登录状态已失效 |
| 404 | `admin_user_missing` | 用户不存在 |
| 404 | `admin_not_found` | 管理接口不存在 |
| 429 | `admin_rate_limited` | 登录、凭证签发或密码校验并发超过限制；按 `Retry-After` 重试 |
| 503 | `admin_unconfigured` | 管理认证未配置、哈希无效或服务已关闭 |
| 500 | `admin_internal_error` | 管理服务内部错误；不向客户端泄漏细节 |

未知管理路由在管理 Router 内返回 JSON 404，不会继续进入普通用户会话中间件。客户端遇到认证失效时，应清除缓存的管理数据，再读取 `/session` 以获得新的匿名登录凭证。
