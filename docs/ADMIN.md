# 管理后台

入口：**https://zhihupipei.aiimage.icu/admin**。使用独立的管理员账号登录；生产用户名为 `admin`，初始随机密码单独交付给站点负责人，不保存在仓库或构建产物中。

## 查看用户与画像

- 概况展示知乎用户、访客、已创建画像、参与发现、当前在线、今日新增和已建立连接等数量。
- 用户列表支持按昵称、用户标识、画像称号及兴趣搜索，按账号来源、画像状态、公开状态和兴趣筛选，并分页查看。
- 用户详情展示六维兴趣雷达、兴趣标签、画像摘要、自我介绍、好奇的问题、交流偏好及生成方式。
- 活动概况仅显示连接、消息、收藏和导入条数等统计。后台不提供原始知乎导入内容、聊天正文、账号令牌或应用凭证。

用户访问前台时会创建临时访客身份；访客不能算作已经完成知乎注册的用户。后台明确区分两种来源，虚构的体验伙伴不进入用户列表。

「加入时间」指用户首次进入站点的时间；「知乎注册时间」指系统记录的首次成功知乎授权。后台上线前的历史注册时间与最近活跃时间可能为空，界面会如实展示。用户之后使用站点时，最近活跃时间每分钟最多写入一次。当前在线数量来自仍连接的前台实时会话，后台访问不会增加前台用户数量。

七天趋势按北京时间的加入日期分组，账号来源按当前状态统计。在线匹配概况来自当前排队和待确认状态；查看后台不会自动开始、确认或取消任何配对。

## 登录与凭证

管理员使用单独的服务端会话及 `soul_admin` Cookie，Cookie 仅发送到 `/api/admin`。生产启用 HttpOnly、Secure 和 SameSite=Strict。登录和退出均校验来源与 CSRF；登录成功轮换会话。会话最长八小时，退出或服务重启即失效。没有配置有效密码哈希时，管理数据接口保持关闭。

生产哈希文件为 `/etc/soulmatch/admin_password_hash`，权限 `0600`，由 [systemd 凭证模板](../deploy/admin-credentials.conf.example) 注入。运行配置只包含管理员用户名和 scrypt 哈希，应用不保存明文密码。

修改密码时，在服务器的 Bash 终端执行：

```bash
read -rsp '新的管理员密码（16–128 个字符）: ' TONGPIN_NEW_ADMIN_PASSWORD
printf '%s' "$TONGPIN_NEW_ADMIN_PASSWORD" | node scripts/set-admin-password.mjs --file /etc/soulmatch/admin_password_hash
unset TONGPIN_NEW_ADMIN_PASSWORD
systemctl restart soulmatch
```

密码通过标准输入传入，脚本不输出密码或哈希，并拒绝把哈希文件写入项目目录。更换密码并重启后，管理员重新登录。前台画像、用户和聊天记录均保存在 SQLite 中。

本地开发可用同一脚本把哈希写入仓库外私有文件，再设置 `SOUL_ADMIN_PASSWORD_HASH_FILE`；可选 `SOUL_ADMIN_USERNAME` 更改用户名。未配置时仍能开发前台，管理页会提示尚未启用。

## 验证

后端使用临时数据库验证管理员身份隔离、来源与 CSRF、会话轮换与退出、登录限流、分页过滤、数据字段最小化和历史数据库迁移。浏览器套件使用构造的虚构用户验证登录、列表、详情、退出和手机布局；不会读取生产用户资料。接口详见 [后台 API](ADMIN_API.md)。

2026-09-13 验证结果：73 项后端检查与 80 项完整浏览器检查全部通过，其中后台浏览器检查为 21 项；公网后台另有 6 项检查通过。报告见 [完整浏览器结果](../artifacts/browser-suite.json)、[后台浏览器结果](../artifacts/browser-admin.json) 和 [公网后台结果](../artifacts/admin-public-validation.json)。
