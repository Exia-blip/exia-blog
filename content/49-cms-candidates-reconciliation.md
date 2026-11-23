## 结论

四个候选我先去看了源码，不只看 README。**材料里有一条是硬错**：Cloudcore 的 RBAC 不是 `roles` / `permissions` / `user_roles` 三表，`src/db/schema.ts` 里只有 `cc_users.role` 一个文本列（默认 `'contributor'`），权限是一张写在 `src/types.ts` 里的常量矩阵：

```ts
export type UserRole = 'admin' | 'editor' | 'contributor';
const PERMISSIONS = { 'content:read': ['admin','editor','contributor'], ... } as const;
export function hasPermission(role: UserRole, permission: Permission) { ... }
```

没有 `roles` 表，没有 `permissions` 表，没有 `user_roles`。所以「只取它的 D1 schema 和权限表设计」这句，能取到的只有**一个 enum 加一张 `action → role[]` 的映射**。这不是坏事——它恰好证明本站的 `is_admin` 0/1 与它是同构的，升级只需要把列从 `INTEGER` 改成 `TEXT`，不是四张表。

**而材料那条硬约束，在本站抓到了两处真的。**

| 材料条目 | 实测 |
|---|---|
| Cloudcore「roles / permissions / user_roles 三表」 | **不存在**。`cc_users.role` 单列 + `PERMISSIONS` 常量表 |
| EmDash「Cloudflare 官方」 | 仓库在 `emdash-cms/emdash`，不是 `cloudflare/*`。Cloudflare 发起、自用、站台，但不是官方仓库 |
| 「SonicJS 的 definePlugin」 | EmDash 的插件 API **也叫 `definePlugin`**，不是 SonicJS 独有 |
| CFBlog「5 级角色」 | **未能核实**。搜不到这个项目与这套角色的出处，可能是我搜不到，也可能不存在 |
| 四者并列时的 license | flare-stack-blog 是 **GPL-3.0**，其余三个 MIT。抄代码的法律面不同，材料没提 |
| 「权限判断只许在中间件和 can() 里」 | **成立**。`src/index.js:1148` 与 `1156` 两处内联复写了 `ownerOrAdmin`，上一轮的断言没抓到 |
| Better Auth「v1.5+ 直接传 D1 binding」 | **成立**。`betterAuth({ database: env.DB })` |
| 「插件是否沙箱是分水岭」 | 成立。EmDash 用 Dynamic Workers（付费），Node 上是 `workerd` 子进程 |
| 「别用首用户即管理员的模板」 | 成立，flare-stack 的 README 现在仍写着这句 |

## 一、四候选实测

| 项目 | 许可证 | 权限模型（源码为准） | 扩展机制 | 前端 | 对本站的代价 |
|---|---|---|---|---|---|
| EmDash | MIT | passkey 优先 + OAuth + magic link；角色在 admin 里配 | `definePlugin` + capability manifest，跑在 Dynamic Workers | Astro 集成 | 换底座。3KB CSS 与手写渲染器全部作废 |
| SonicJS | MIT | `requireAuth()` / `requireRole('admin')` 中间件 | `definePlugin` + `registerPlugins`，两阶段 boot | Hono + HTMX / React 管理端 | 数据结构是 `documents` 通用表，与现有 D1 表差一个数量级 |
| Cloudcore | MIT | `cc_users.role` 单列三值 + `PERMISSIONS` 常量表 | 无插件机制，改内核 | React 18 + Vite + Tailwind + Tiptap | 管理端废掉现有 CSS；README 自己建议生产环境挂在 Cloudflare Access 后面 |
| flare-stack-blog | **GPL-3.0** | Better Auth + 首个用户即管理员 | 主题契约整站替换、Webhook、开放 API | React 19 + Tailwind 4 + TanStack Start | 整个前端换掉，且 GPL 传染 |

三个可证伪点补充：

1. **EmDash 的 star 数对得上**（2026-11-18 快照 14,493）。但「Cloudflare 官方」这个说法会让人以为 `github.com/cloudflare/emdash`，实际不是。它是 Cloudflare 在 2026-04-01 开发者预览时宣布的项目，作者是 Matt Kane（Astro 内容层）与 Matt Taylor，Cloudflare 博客自己在 1.0 之前就迁过去了——「customer zero」是它的背书，不是所有权。
2. **SonicJS 的两阶段 boot 材料没提，而这是抄它时最容易踩的地方**：`register(app)` 必须在构造期同步调用（Hono 在首个请求后锁死路由表，之后再 `app.get()` 静默无效），`onBoot(ctx)` 要等首个请求才跑（那时 `env` 才有 D1/R2 绑定）。本站没有 Hono，也没有「构造期」这个概念，Worker 是 `export default { fetch }`，每次请求进来才拿到 `env`。要抄这个约定，得自己造一个「首次请求时执行一次的初始化」——本质就是 `onBoot`，但得自己写。
3. **SonicJS 的 `CACHE_KV` 是必填绑定**。本站没有 KV。抄它的骨架会顺手引入一个现在不存在的依赖。

## 二、材料错在哪，以及为什么这个错重要

`roles` / `permissions` / `user_roles` 是教科书写法（也是 48 篇里那个「四表 RBAC」模板的形状）。但 Cloudcore 没这么做，SonicJS 也没有——SonicJS 是 `role` 字段加中间件，权限判断写在 `requireRole('admin')` 的调用点上。

这不是它们偷懒。**三角色、十来个动作的系统，表驱动是过度设计**：`roles` 表只有三行，`permissions` 表二十行，`user_roles` 每用户一行——三张表的存在意义是「运营能在后台改权限」，而这三个项目都没有做这个界面。它们把权限写死在代码里，改权限要发版。这是有意识的取舍，而且是对的。

对本站的含义：**如果要升级，第一步不是建表，是 `is_admin INTEGER` → `role TEXT`**。这一步的迁移只需要：

```sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'reader';
UPDATE users SET role = CASE WHEN is_admin = 1 THEN 'admin' ELSE 'reader' END;
```

（真做的时候不用 `ALTER`，走 `migrations/NNNN_*.sql`，见下文「明说的没做」。）

建四张表反而是把「改一个字符串」变成「三表 JOIN」——多两次查询、多三个可能不一致的地方，换来的能力（后台改权限）现在没人用。

## 三、那条硬约束，抓到了两处

材料原话：**「权限判断只许出现在中间件和 can() 里，不许散在 handler。散一处漏一处，就是一个越权。」**

上一轮我把 API 层五处 `p.author_id !== u.id && !u.is_admin` 收口成了 `ownerOrAdmin()`，并写了 `AP-15` 断言「源码里裸判定必须已清零」。全绿。

这一轮照着材料重新全站扫了一遍，`src/index.js` 的文章详情页有两处：

```js
// 1148：预排稿闸门
if (!post.is_live && !(user && (user.id === post.author_id || user.is_admin))) {
// 1156：审核闸门
if (post.review_status && post.review_status !== 'approved'
    && !(user && (user.id === post.author_id || user.is_admin))) {
```

两处都是 `ownerOrAdmin` 的手写复制品，注释里还写着「作者与站长例外」。**线上跑了一整轮。**

### 断言为什么没抓到

`AP-15` 的正则长这样：

```js
const bare = /author_id\s*!==\s*[a-z]+\.id\s*&&\s*![a-z]+\.is_admin/;
```

它只认「`!==`、`author_id` 在左、`&&`、`!is_admin`」这一种写法。`index.js` 写的是「`===`、`user.id` 在左、`||`、`is_admin` 不带 `!`」——四个维度全反过来。同一个语义，四种写法，断言只守了一种。

这是假绿的第二种形态。上一轮抓到的是**异步用例被同步 catch 吞掉**（P-029：断言根本没执行）；这一轮是**断言执行了，但只认识一个方向**。前者靠改 `t()` 修，后者改不掉——只要断言是「匹配某个字符串」，就永远有下一个写法绕过它。

修法是换判据：不再问「这个写法在不在」，改问「这个概念出现在哪些文件」。

```js
// AP-15 现在扫全部 src/*.js，逐行找同时含 .author_id + (.id|is_admin) + (===|!==) 的行
for (const f of files) {
  if (f === 'auth.js') continue;           // ownerOrAdmin 的唯一实现点
  line.match(...) -> offenders.push(`${f}:${i+1}  ${line.trim()}`)
}
assert.deepEqual(offenders, []);
```

SQL 里的 `u.id = p.author_id` 是单等号，天然不命中，不需要排除表名。失败信息直接给文件名加行号，不用猜。

配套加了两条：

- **AP-16**：除 `auth.js` 外，任何文件出现 `is_admin ? 'approved'` 即红。这是第二类散落——新建与更新两处各写了一遍审核态三元（`src/api.js:832`、`922`），语义是「管理员写的稿直接通过，其余待审」。现在收成 `reviewStatusFor(user)`，规则只有一处。它和 `ownerOrAdmin` 分家的理由：那个答「你能不能碰这一行」，这个答「你写的东西要不要排队」。
- **AP-17**：`ownerOrAdmin` 必须 null-safe。因为 SSR 闸门原来自带 `user &&` 保护，换成函数调用后这层保护交给了函数体——`if (!user || !post) return false`。没有这条断言，某天有人「优化」掉那个守卫，未登录访客访问私密文章会直接 500。

验证方式按 P-030 自己写的规矩来：**先把 `index.js` 那行改回旧写法，看着断言红并报出 `index.js:1148`，再改回来。** 注入-变红-回滚，三步都做了。

## 四、为什么还是不引 visibility / can() / 四表

材料建议的落地顺序是「先加 `visibility` 字段 → 再加 auth 中间件 → 权限收口成 `can(user, action, resource)` → 真需要时上 RBAC 四表」。第三条我做了，另外三条都没做，理由分开说。

**`visibility` 不需要加。** 本站已经有三个正交的开关：

| 列 | 管什么 | 谁能改 |
|---|---|---|
| `published_at`（`is_live` 派生） | 到点才可见，用于预排 | 作者（编辑器里设时间） |
| `is_private` | 仅作者与站长可见，未登录 404 | 作者 |
| `review_status` | 待审 / 通过 / 驳回 | 只有站长（`/admin/review`） |
| `hidden` | 列表隐藏但直链可达 | 作者 |

`visibility`（`public` / `unlisted` / `private`）是这三者的另一种切法，加进来必然出现「`visibility='private'` 但 `review_status='approved'`」这种要额外定义含义的组合。**一个字段表达不了的语义，加一个字段不会让它变清楚。**

**`can(user, action, resource)` 还是空壳。** 现在全站只有两种判据：资源级的 `ownerOrAdmin(user, post)` 和角色级的 `reviewStatusFor(user)`。`can()` 需要「同一动作在不同资源上含义不同」才划算——比如「删」对文章是作者或站长，对评论是作者或站长，对用户只有站长。第三条现在没有。上一轮的判断没变。

**四表不上。** 见第二节：`role` 一列够用。等真出现第三种角色、且需要「编辑能审别人的稿但不能改设置」这种细分时再说。现在 `is_admin` 只有 0 和 1，本身就是「读者 / 站长」的二分。

## 五、四选一里唯一值得抄的东西

不是表，不是插件系统，是 **`hasPermission(role, action)` 那个形状**：

```ts
const PERMISSIONS = { 'content:publish': ['admin','editor'], 'users:delete': ['admin'] } as const;
```

好处是**判定变成一个查表**：加角色不改任何 handler，只改一行数组。坏处是它把「资源归属」挤出去了——`canEditContent` 单独写了一个函数，因为「contributor 只能改自己的草稿」不是角色能表达的。

这正好印证了本节之前那两节：**角色能力查表，资源归属走函数，两者别混。** 本站现在就是这个形状（`reviewStatusFor` 是查表退化成一个 `if`，`ownerOrAdmin` 是资源函数），只是没有那张表——两种角色不需要。

至于插件系统：`definePlugin` 的约定（`register` / `onBoot` / 中间件复用）确实是「最小改动拿到插件架构」的方案，但它是为「第三方插件」设计的，而本站没有第三方。真到要写第二个站点的那天再抄，那时的成本与现在一样——三样东西，一百行以内。

## 明说的没做

1. **没有迁移任何四候选的数据或表。** 这一轮改的是两处内联判定和一个三元，没有加表、没有加列、没有加依赖。
2. **`visibility` 没加，`can()` 没建，四表没建。** 理由在第四节，不是排期问题。
3. **Better Auth 没引。** 它确实支持 `database: env.DB` 直传 D1（v1.5+），但会带进 `user` / `session` / `account` / `verification` 四张自己的表，与现有 `users`（`github_id` / `login` / `is_admin`）异构。四表与四表之间至少要一次映射，换来的能力是「多 provider 登录」——现在只有一个 GitHub。
4. **CFBlog 没核实成功。** 「5 级角色（管理员/编辑/作者/投稿者/订阅者）」这套说法我找不到出处。如果是材料作者记混了某个 WordPress 系的角色表，那它不该出现在候选对比里。
5. **`check-live` 的四条还是红的。** 这一轮的改动同样没部署，线上仍是旧代码；部署后 `check-live` 应该转绿，届时再补一轮线上核对。

## 复现条件

- 环境：本机 Node 22，仓库 `main`，无网络依赖的断言（网络部分只用过一次 GitHub API 读 schema，结论已写进正文）
- 触发：`node scripts/test-auth-policy.mjs`
- 期望：`17/17 passed`；把 `src/index.js:1148` 改回 `!(user && (user.id === post.author_id || user.is_admin))` 后期望 16/17 并报出该行
- 实际：一致

## 断言代码

```bash
node scripts/test-auth-policy.mjs   # AP-15 全站白名单扫描 / AP-16 审核态唯一来源 / AP-17 null-safe
npm test                            # 含 PITFALLS 双向对账（30 条）
```
