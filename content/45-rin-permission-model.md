## 结论

一份关于 Rin 权限模型的材料给了四步路线。我照着代码逐条对了一遍，结论是：**第一步已经投产、第二步命中了我自己的一处硬伤、第三步（权限收口）只对了一半、第四步明确不该做**。

| 材料的建议 | 实际情况 |
|---|---|
| 第一步：只加 `visibility` 字段（公开 / 未列出 / 仅自己） | **早就有**，而且是两个独立布尔，比单个 `visibility` 字段更细。线上 40 篇里三种态都在用 |
| 第二步：auth 中间件 + 单用户白名单（GitHub ID 走环境变量） | **没有白名单**。任何 GitHub 账号登录即成普通用户。这一轮补上了 |
| 第三步：权限收口，「权限判断只在中间件里出现一次」 | `requireAdmin()` 早就是一处实现；真正散落的是**资源级**判定，8 个 handler 各写一遍。这一轮收掉了 |
| 第四步：角色表 + 资源级 ACL | 不做。材料自己也说这一步 Rin 的结构完全不够用，得自己设计 |

材料还建议一条「更轻的做法」：不建用户表、不签发 JWT，只把 GitHub OAuth 当第二把钥匙。**这条已经错过了** —— `users` 表、30 天 JWT、`is_admin` 早在 2026-10 就在线上跑，已有 2 行数据。所以现在能选的不是「建不建权限系统」，而是「注册口子开多大」。

最重要的那条：材料批评 Rin「首个登录的用户自动获得管理员」，而我的 `src/auth.js` 里写着同一行 —— `const isFirst = count.c === 0; ... isFirst ? 1 : 0`。上一篇文章里我已经把这条记下来了，这一轮才真正改掉。

## 一、「第一步」早就做完了，而且比材料建议的更细

材料说：先只加一个 `visibility` 字段（公开 / 未列出 / 仅自己），完全不动认证，零攻击面增加。

`posts` 表里这东西有两个，不是三个枚举值：

```sql
is_private    INTEGER NOT NULL DEFAULT 0,  -- 私密：仅作者可见，未登录 404
hidden        INTEGER NOT NULL DEFAULT 0,  -- 不列入首页
review_status TEXT NOT NULL DEFAULT 'approved'  -- approved / pending / rejected
```

三态是这么落出来的：

| 意图 | `is_private` | `hidden` | 实际行为 |
|---|---|---|---|
| 公开 | 0 | 0 | 列表、RSS、sitemap、`/numbers` 全收录 |
| 未列出 | 0 | 1 | 首页与归档不列，直链可访问，但响应头带 `noindex,follow` |
| 仅自己 | 1 | 0 | 未登录 404（不是 403 —— 报 403 等于承认这篇存在），`cache-control: private, no-store` |

线上分布，刚查的：

```
0/0/approved   37 篇
1/0/approved    2 篇
0/1/approved    1 篇
```

三种态**都已经在真实使用**，不是写了没跑过的字段。这比单个 `visibility` 字段多出的那一点是：`hidden` 和 `is_private` 可以叠加，于是「不列入首页但公开可读」和「私密」是两条互不干扰的开关 —— 单字段枚举做不出第一种组合。

所以材料的第一步对我不是「新任务」，是「已验收项」。这一步的价值在于它证明了那个过渡路径是对的：先加可见性、不碰认证，确实可以零风险地支撑起草稿箱。

## 二、「权限校验散落在 handler 里」——对了一半

材料的原话是：「你的单 Worker 现在把评论、友链、图片、渲染挤在一起，上多用户时最先崩的就是这块 —— 权限校验散落在各 handler 里，漏一处就是一个越权。」

查完，这句话一半对、一半错。

**对的那一半不是 `requireAdmin`。** 它早就是一个收口函数，`src/api.js` 17 处调用、`src/admin-pages.js` 6 处，但都是同一个实现：

```js
export async function requireAdmin(env, request) {
  const { user, res } = await requireUser(env, request);
  if (res) return { user: null, res };
  if (!user.is_admin) return { user: null, res: json({ ok: false, error: '需要管理员权限' }, 403) };
  return { user, res: null };
}
```

23 个调用点、一个实现、一处 `is_admin` 读取。这一层没散。

**真正散落的是资源级判定。** 「本人或管理员」这个条件，在 8 个地方各写了一遍：

```js
// src/api.js —— 7 处
const owner = user && (user.id === p.author_id || user.is_admin);     // 单篇读取
if (p.author_id !== u.id && !u.is_admin) return err('无权查看', 403);  // 版本历史
if (p.author_id !== u.id && !u.is_admin) return err('无权编辑', 403);  // AI 摘要
if (p.author_id !== u.id && !u.is_admin) return err('无权编辑', 403);  // 更新
if (p.author_id !== u.id && !u.is_admin) return err('无权删除', 403);  // 删除
if (p.is_private && (!user || (user.id !== p.author_id && !user.is_admin))) return err('文章不存在', 404);  // 评论读取
if (p.is_private && (!user || (user.id !== p.author_id && !user.is_admin))) return err('文章不存在', 404);  // 发评论

// src/index.js —— 1 处（SSR 单篇）
if (post.is_private && (!user || (user.id !== post.author_id && !user.is_admin))) { ... }
```

注意后三处的括号多套了一层：`!user || (...)`。这个条件其实是「不是作者也不是管理员」的否定形式，也就是说 —— 同一件事有**两种写法**。两种写法都对的现在，靠的是每次复制时都没抄错。这正是材料说的「漏一处就是一个越权」，只是漏的位置不在它以为的地方。

### 收口后

新增一处实现，8 个调用点：

```js
/**
 * 资源级判定：作者本人或管理员。
 * 过去五处 handler 各写一遍 `p.author_id !== u.id && !u.is_admin`，
 * 新增路由时只能靠记忆复制——抽成一处，越权判断就只有一个实现。
 */
export function ownerOrAdmin(user, post) {
  if (!user || !post) return false;
  return user.id === post.author_id || !!user.is_admin;
}
```

那个 `!user || !post` 的短路不是防御性编程的装饰，它替代的是原来 `!user ||` 那层括号。区别是：原来每处都要记得写对优先级，现在只需要写对一次。

## 三、硬伤：管理员席位先到先得

这是本轮唯一一处「材料说对了、我确实错了」的地方。

原逻辑：

```js
const count = await db.prepare('SELECT COUNT(*) AS c FROM users').first();
const isFirst = !count || count.c === 0;
await db.prepare('INSERT INTO users (github_id, login, name, avatar, email, is_admin, created_at) VALUES (?,?,?,?,?,?,?)')
  .bind(..., isFirst ? 1 : 0, nowISO())
  .run();
```

「系统里第一个用户是管理员」在单实例、闭站、只有自己知道地址的场景里是合理的便利设计。但这个前提条件跟「注册入口对任何 GitHub 账号开放」是矛盾的：一旦有人比你先点登录，管理员就是他的了。

我的实例侥幸没中——2026-10-30 我建 id=1 的时候，站还没公开。窗口关了，机制没关：清库、换 D1、开新环境，窗口立刻重开。而这类项目最典型的部署方式恰好就是「开个新环境」。

### 改成什么

两个可选环境变量，都不配就等于旧行为（一次部署不会把现有实例锁死）：

```js
export function admitPolicy(env) {
  const allow = csvList(env.ALLOWED_LOGINS);   // 逗号分隔，大小写不敏感
  const admins = csvList(env.ADMIN_LOGINS);
  return { allow, admins, open: allow.length === 0 };
}

export function decideAccess(env, login, isFirst) {
  const p = admitPolicy(env);
  const l = String(login || '').toLowerCase();
  if (!l) return { ok: false, reason: 'missing-login' };
  if (!p.open && !p.allow.includes(l)) return { ok: false, reason: 'not-allowed' };
  // 配了 ADMIN_LOGINS 就完全以它为准，不再看 isFirst
  const admin = p.admins.length ? p.admins.includes(l) : !!isFirst;
  return { ok: true, admin: admin ? 1 : 0 };
}
```

三个细节值得单独说：

1. **判定必须在建行之前。** 名单外的账号不该在 `users` 表里留下任何痕迹，更不该拿到一枚 30 天有效的会话 cookie。写成「先建、再判、不行就删」也能跑通，但那等于把拒绝变成了事后补救。
2. **`ADMIN_LOGINS` 配了就以它为准，每次登录同步回库。** 这解决了一个老问题：过去要撤一个人的权，只能去改库，或者换 `SESSION_SECRET` 把所有人踢掉。现在改环境变量、他下次登录就降级——比换密钥温和得多。
3. **空 login 直接拒。** GitHub 返回畸形体时不该建出一行空记录。

## 四、实测数字

| 项 | 数值 |
|---|---|
| 收口前资源级判定重复 | **8 处**（api.js 7 + index.js 1），两种写法 |
| 收口后 | **1 处实现，8 个调用点**；裸写的 `author_id !== … is_admin` 归零 |
| `requireAdmin` 调用点 | 23（api.js 17 + admin-pages.js 6），本就是一处实现 |
| 线上用户 | 2 行：`id=1 is_admin=1`（2026-10-30 建）、`id=2 is_admin=0` |
| 线上文章三态分布 | 公开 37 / 私密 2 / 未列出 1 |
| 新增断言 | 15 条（`[P-021]`），3 次注入验证均按预期变红 |
| 每次管理请求的 `users` 查询 | **2 次**（入口 `currentUser` 一次，handler 里 `requireAdmin` 又一次） |

最后那行是这轮看清楚但没改的一个事实：`handleApi` 入口已经查过一次当前用户，`requireAdmin` 内部又查一次。收口让权限判定只出现一次，但**没有让查询只出现一次**。要省掉那一次，得把入口查到的 user 透传进 23 个 handler——改动面比收益大，先记着。

## 五、复现条件

- 环境：本地 `node scripts/test-auth-policy.mjs`；线上 D1 只读查询
- 触发：`ALLOWED_LOGINS=exia-blip` 后，用另一个 GitHub 账号走 `/auth/callback`
- 期望：不建 `users` 行、不发 cookie、落一个说明页；实际：同上（由 `decideAccess` 的 `not-allowed` 分支保证）

## 六、断言

```bash
node scripts/test-auth-policy.mjs    # [P-021] 15/15
```

15 条分三组：

- **AP-01~04 策略解析**：不配时保持开放注册；白名单大小写与空格容错；名单外拒绝；空 login 拒绝。
- **AP-05~12 角色与资源判定**：不配 `ADMIN_LOGINS` 回落 `isFirst`；配了就完全不看 `isFirst`；`ADMIN_LOGINS` 里的人若不在 `ALLOWED_LOGINS` 内仍被拒；`ownerOrAdmin` 的四象限（作者/管理员/路人/未登录）。
- **AP-13~15 元断言**（读源码）：`INSERT INTO users` 那段里不许再出现 `isFirst ?`；`if (!access.ok)` 必须早于 `INSERT`；`api.js` 与 `index.js` 里裸写的 `author_id !== … is_admin` 必须为 0 处、`ownerOrAdmin(` 至少 5 处。

AP-13~15 是这一组里唯一有意思的部分。前 12 条测「函数算得对」，后 3 条测「调用点还在」——和上一轮 `test-md-guard.mjs` 那套变异测试同一个思路：没验证过会失败的断言等于没写。三条都真验过：

| 注入 | 结果 |
|---|---|
| `INSERT` 里把 `access.admin` 换回 `isFirst ? 1 : 0` | AP-13 红 |
| 把 `if (!access.ok)` 那段挪到 `INSERT` 之后 | AP-14 红 |
| 一处置回 `p.author_id !== u.id && !u.is_admin` | AP-15 红 |

## 七、明说的没做

1. **没上角色表和资源级 ACL。** 材料说得对：到那一步 Rin 的结构完全不够用，得自己设计。而我现在的目标不是做成平台——没有 `/admin/users` 页面、没有「谁能编辑哪一篇」这种粒度，`is_admin` 一个布尔管到底。加 ACL 就是给自己造一类新的越权面。

2. **没优化那次重复的 `users` 查询。** 管理请求的成本里有 2 次 D1 往返，其中至少 1 次是冗余的。但「透传 user 到 23 个 handler」会把现在这个干净的 `requireAdmin()` 签名改脏，收益是几毫秒，等有真实压测数据再说。

3. **没有线上演练白名单。** 15 条断言跑的是本地函数，`ALLOWED_LOGINS` 真的写进 Worker 环境之后，拒绝页长什么样、cookie 会不会被边缘缓存住，一次都没验过。这是第二次出现同类缺口了（上一次是 `READONLY_MODE`），说明我的断言体系有个系统性盲区：**越过 HTTP 边界的那一层永远靠推理**。

4. **Rin 侧细节未独立复核。** 材料说 `setup.ts` 是「Elysia/Hono 中间件」——Rin 用的是 Hono（`^4.12.2`），不是 Elysia，这句话本身就不确定。`services/user.ts` 的首次登录判定、`permission` 0/1 的分法、v0.2.0 的破坏性变更，都按材料口径引用，没去翻锁定 commit。本文所有关于本站的结论都来自仓库代码与线上 D1 只读查询。

5. **准入白名单默认是关的。** 部署后不配 `ALLOWED_LOGINS` 就等于没改——旧行为原样保留。这是故意的：一次部署不该把现有实例锁死。真正启用需要你加两个变量。
