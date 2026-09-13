# 同频、同题迁入同知

入口是 `scripts/migration/migrate.mjs`，仅操作本地 SQLite，不调用模型或知乎接口。支持源库检查、一致快照、临时演练、指定空目标导入和导入后校验。迁移数据、账号凭据、私有名单和备份均不应提交 Git。

迁移工具需要 Node.js **22.16 或更高版本**，使用原生 `node:sqlite.backup`。项目运行环境的最低版本可能更低，执行迁移前以 `node --version` 为准。

## 执行顺序

正式切换前应停止两套旧应用的写入，再各取一次最终快照。SQLite 备份包含已提交的 WAL 数据，但只能保证每个库自己的快照一致性；演练期间仍在使用的旧站可能在快照之后产生新内容。演练快照不自动包含这些增量。工具不会停止服务或切换域名。

以下路径均为示例，需替换成部署机器上的私有目录和数据库路径。

```sh
umask 077
install -d -m 700 /private/migration/final

node scripts/migration/migrate.mjs inspect --project tongpin --source /old/tongpin.sqlite
node scripts/migration/migrate.mjs inspect --project tongti --source /old/tongti.sqlite

node scripts/migration/migrate.mjs snapshot --source /old/tongpin.sqlite --output /private/migration/final/tongpin.sqlite
node scripts/migration/migrate.mjs snapshot --source /old/tongti.sqlite --output /private/migration/final/tongti.sqlite

node scripts/migration/migrate.mjs dry-run \
  --tongpin /private/migration/final/tongpin.sqlite \
  --tongti /private/migration/final/tongti.sqlite \
  --identities /private/migration/final/verified-subjects.json

node scripts/migration/migrate.mjs apply \
  --tongpin /private/migration/final/tongpin.sqlite \
  --tongti /private/migration/final/tongti.sqlite \
  --identities /private/migration/final/verified-subjects.json \
  --target /new/data/tongzhi.sqlite

node scripts/migration/migrate.mjs validate --target /new/data/tongzhi.sqlite
```

两个来源至少提供一个。没有已核实的知乎身份时可省略 `--identities`；所有旧用户仍会迁入，但不会自动获得知乎登录绑定。

`inspect` 只返回表名、列名和行数，不返回记录内容。`snapshot` 拒绝覆盖已存在的目标，备份文件权限为 `0600`。临时目录权限为 `0700`。备份包含原库内容，应按私有数据库保管；旧会话等敏感状态只会出现在原始备份中，不会写入新库。

`dry-run` 对来源再次取快照，在独立临时目标完整执行导入和校验，结束后删除临时目录。它不接受 `--target`。`apply` 只接受不存在的目标、没有任何记录的 SQLite 数据库，或由完全相同输入生成且尚未改变的迁移目标。源/目标同文件、符号链接目标和指向源库的硬链接会被拒绝。

先在新应用启动前运行 `validate`，保存报告，再启动新站并验证登录、历史小组和私信。**这条校验命令检查初次导入状态，不是上线后的健康检查**：新会话、用户编辑和授权变化都会让初次导入指纹不再匹配。

## 知乎身份名单

名单为 UTF-8 JSON，使用 `0600` 权限保存：

```json
{
  "version": 1,
  "verifiedIdentities": [
    {
      "sourceProject": "tongpin",
      "userId": "example-old-user-id",
      "kind": "hash",
      "value": "example-hash-id"
    },
    {
      "sourceProject": "tongti",
      "userId": "example-other-old-user-id",
      "kind": "uid",
      "value": "18446744073709551615"
    }
  ]
}
```

`value` 必须是字符串，UID 只能由十进制数字构成，不经过 JavaScript 数值转换。名单中的旧用户、身份类型和身份值必须与对应源记录完全一致。

- 同频旧 `users.subject` 没有类型前缀。源码选择 `hash_id`，没有时才选择 UID；可据源码核实非纯数字值为 hash，纯数字值不能仅凭外观判断类型。
- 同题旧 `users.zhihu_id` 已有 `hash:` 或 `uid:` 前缀。确认来源语义后，将前缀和原值分别填入 `kind`、`value`。
- 只有名单内相同的 typed 身份才会跨项目合并。昵称、头像、邮箱相同都不是合并依据。
- 新规范为 `identities.provider='zhihu'`，`identities.subject='hash:<value>'` 或 `'uid:<value>'`。导入用户的 `users.subject` 保持 `NULL`，由新 OAuth 的 typed identity 查询恢复原账号。
- 原始标识另外保存在 `legacy:tongpin:zhihu`、`legacy:tongti:zhihu` 身份命名空间，不能作为新登录的自动认领入口。
- 游客记录独立保留，旧会话不迁移。新游客不能凭昵称认领旧记录。无法验证身份的历史记录不会被自动归给新用户。

旧同题邮箱会规范化大小写和域名，密码哈希原样保留为 `scrypt-v1$<salt hex text>$<digest hex>`。新验证器使用旧格式的盐文本，已有密码可继续登录；停用状态仍然有效。规范化邮箱冲突会中止导入，不会据邮箱合并两个人。旧站的管理员角色只保存在私有迁移元数据中，不授予新站独立管理入口的权限。

## 数据映射

每个来源的旧 ID 均有项目命名空间。`legacy_id_map(source_project,entity_type,old_id,new_id)` 保存映射，复合键使用 JSON 数组编码。未能解析的历史引用使用 `unresolved_message`、`unresolved_source` 或 `unresolved_user` 类型保留可追踪标识。

| 来源 | 内容 | 同知目标 / 映射类型 |
| --- | --- | --- |
| 两站 | 用户、已验证身份 | `users`、`identities` / `user` |
| 同题 | 邮箱密码与停用状态 | `email_accounts`、`users.status` / `email_account` |
| 同频 | 画像、私有导入 | `profiles`、`imports` / `profile`、`import` |
| 同频 | 收藏 | `saved` / `saved` |
| 同频 | 邀请与私信 | `invitations`、`messages` / `invitation`、`message` |
| 两站 | 定向屏蔽 | `blocked` / `block` |
| 同题 | 小组与历史轮 | `circle_groups`、`circle_rounds` / `community`、`historical_round` |
| 同题 | 成员和主持关系 | `circle_memberships` / `membership` |
| 同题 | 讨论与进展动态 | `circle_messages` / `message`、`update` |
| 同题 | 原始来源卡 | `circle_sources` / `source` |
| 同题 | 当前成果与已有版本号 | `circle_outcomes`、`circle_outcome_versions` / `artifact` |
| 同题 | 举报 | `circle_reports` / `report` |

额外的历史说明消息使用 `history_notice` 映射，每个旧小组一条。原头像、参与频率说明、旧管理员角色、缺失版本说明等保存在 `legacy_metadata` 中，避免将这些差异误写成新产品的授权或状态。用户相关元数据有用户外键，用户删除时会随之删除。

旧会话、CSRF、OAuth state、浏览器绑定、管理启用令牌、管理会话及知乎校验缓存不迁移。不会创建待执行工作、通知或新的匹配任务。旧待处理邀请会变为 `cancelled`，已有接受关系和消息仍然保留。

## 历史轮次和隐私

同题旧版更换话题时会覆盖小组当前问题，没有保存完整轮次。每个旧小组因此对应一个明确标注的归档历史轮，显示“最后记录的问题”，原消息、来源、动态和成果按原时间保留。不会将旧问题误标成所有历史讨论的共同主题，也不会猜测轮次边界。

旧成员和主持人关系保留，归档轮不能由新访客直接加入。原主持人可以主动开启下一轮。旧 `participation` 是参与频率描述，不解释成临时成员期限。未读位置根据消息和动态合并后的时间线，取旧两个读游标共同确认已读的连续前缀；原始 SQLite rowid 不会直接复制到新游标。

旧成果只有当前正文和版本号。导入保留这一版本号和一份真实快照，不伪造之前的版本正文。“已核对”保留为最后编辑者的核对，不等于所有成员达成共识。

初始状态采用以下设置：

- 旧画像保留为私有，`discoverable=0`。
- 所有导入用户的群内邀请、AI 分析、聊天分析、通知摘要均关闭。
- 小组自动主持和自动摘要关闭；成员订阅、群内连接、AI 同意均关闭。
- 旧模型内容没有可验证的新分析授权，保留数据库记录但隐藏展示。旧规则开场可能包含无法追溯的成员目标，也保持隐藏。
- 规则整理的已知依赖继续有效，并保守补入当时更早的真人发言和来源。隐藏原文、屏蔽作者或隐藏来源后，应用原有递归依赖检查继续遮蔽衍生文本。

所有 `citations[].messageId`、`source_ids`、`dependency_ids`、回复和成果来源消息都重新映射；目标新增的 `dependency_source_ids` 由来源时间保守补齐。引用中的作者和摘录由现存原始消息重新生成，避免继续展示旧的失效摘录。模型授权引用使用映射后的用户 ID。

缺失或跨小组的 JSON 引用不会静默变成空数组：保留对应标识并隐藏受影响记录。无法解析的回复会取消链接并隐藏消息。格式损坏的 JSON、缺失的必需私信参与者、重复主持人、邮箱冲突等会使整个导入事务回滚。

## 重复执行、报告和恢复

报告只含项目名称、计数、哈希、迁移批次和警告代码，不含用户正文、邮箱、身份原值或密码。`source_fingerprint` 基于允许迁移的逻辑表内容和顺序；源会话等不迁移的状态变化不会造成重复导入。

相同来源和相同身份名单重复 `apply` 返回 `alreadyApplied: true`，不复制数据。目标有用户活动、源正文发生变化或身份名单改变时，会拒绝原地再导入，防止覆盖新站数据。确需重新演练时，应使用另一个空目标。工具不提供增量合并或已上线目标的覆盖操作。

`validate` 检查 SQLite 完整性、外键、源记录到目标的映射数量、私信参与者、圈子与轮次边界、JSON 引用、已隐藏的缺失依赖、成果版本快照、读游标、隐私默认以及初始迁移指纹。新应用启动时添加的空表不改变该指纹。

常见拒绝代码：

| 代码 | 处理 |
| --- | --- |
| `target_not_empty` | 选择新的空数据库路径，勿覆盖当前应用数据。 |
| `target_contains_other_migration` | 输入或身份名单与目标批次不同，使用新目标重演。 |
| `target_changed_after_migration` | 目标已有变动；不要将首次导入校验用于日常健康检查。 |
| `identity_manifest_source_mismatch` | 在私有环境核实来源账号、类型和值，切勿按昵称猜测。 |
| `email_identity_conflict` | 人工核实冲突账号；工具不会自动按邮箱合并。 |
| `invalid_json` / `required_user_missing` | 核实源快照结构与记录完整性，原站不受影响。 |
| `database_operation_failed` | 操作已中止；检查私有数据库的结构和权限，日志不会回显原始记录。 |

导入失败时，新建的未提交目标会删除；已有空目标的所有数据写入会回滚。来源始终以只读连接访问。若新站尚未对外写入，可保留失败目标供私有检查，使用另一个空路径重新导入，或将服务指回仍保留的旧应用和原库。新站一旦产生用户数据，应先另取新站快照并规划增量处理，不能用旧快照直接覆盖。

## 验证

```sh
node --test tests/migration.test.js
```

专项测试完全使用合成旧库，覆盖 WAL 一致性、文件权限、命名空间与 typed 身份、游客隔离、邮箱密码兼容、停用账号、未迁移会话、私信外键、定向屏蔽、历史轮次和成果版本、合并游标、完整依赖与实际展示遮蔽、无敏感内容的 CLI 输出、幂等与失败回滚。
