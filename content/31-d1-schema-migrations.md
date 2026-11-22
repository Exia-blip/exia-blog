## 结论

表结构没有版本记录的时候，它其实有三份互相矛盾的描述：线上真跑着的库、`db:init` 用的 `schema.sql`、还有代码里默认「这张表有这些列」的 SQL。三份各说各话，谁也不负责跟谁对齐。第一次跑 `scripts/schema.mjs check`，三处漂移当场抓到，外加一笔本地库的旧账。

最险的一处是 `schema.sql` 的 `friends` 表少了 `http_status` 和 `latency_ms`。`src/cron.js` 会写这两列，用 `db:init` 建出来的新库一上线就撞 `no such column`——这类问题在开发机上测不出来，因为线上库一直有这两列，cron 一直在写，缺的只是那份当「标准」用的建库脚本。

另外两处是索引的双向漂移：`schema.sql` 记着 `idx_pv_day` / `idx_pv_path`，线上根本没有；线上有 `idx_posts_published` / `idx_posts_series` / `idx_comments_ip`，`schema.sql` 一个没记。少记的索引不会报错，只会让「按这个结构重建一份」从一开始就不可信。

修法不是再重写一份 `schema.sql`，是承认它不可信，改成一份可重放的基线加一套检查。`migrations/0001_baseline.sql` 从线上 `sqlite_master` 导出，全部 `IF NOT EXISTS`；存量库 apply 是 **21 commands / 1.45ms** 的 no-op，只让 wrangler 在 `d1_migrations` 里记一笔，空库则一次建齐。

三份描述都不会自己报错。线上库照常服务请求，`schema.sql` 照常能建出一个库，代码照常在已有库上写成功——每一份在自己的上下文里都是对的，只有把它们两两摆在一起才露出裂缝。漂移这个叫法很贴切：不是谁错了，是它们各自走远了。

这套东西挂在一个 Worker 上跑，整体取舍写在[单 Worker 博客的架构全貌](/p/workers-blog-pillar)里。这一篇只讲数据层那一格：提交 `0be25e6`，线上 `check:live` 73/73。

## 一、先承认没有版本记录

这些表是「写功能时顺手 `ALTER` 一下」长出来的。加友链检测就 `ALTER TABLE friends ADD COLUMN http_status`，加封面就给 `posts` 加一列。每次只改当下要用的那个库，改完不记，也没有一个文件说「到现在为止结构长这样」。

顺手 `ALTER` 的诱惑在于成本看着是零：一行命令，当场解决眼前的功能，没有失败反馈。它的成本只在出现第二个环境那一刻才结算——而第二个环境迟早会出现，可能是一台新机器，可能是一次灾难恢复，也可能只是本地库被清掉重建。

没有版本记录的代价不是乱，是没法回答一个很具体的问题：眼前这个库，是从哪一步长成现在这样的。每台库都有自己的 ALTER 史——线上改过线上的列，本地改过本地的列，`db:init` 手里是某一时刻的快照。三份描述不是三个人写的三种观点，是同一份代码在不同时间点留下的三个切片。

我第一反应是去翻 `schema.sql`，以为它就是答案。翻完发现它只是 `db:init` 用的建库脚本，后来加的列没人同步回去；而且它和线上库从来没被比对过，连「两者是不是不一样」都没人知道。所谓三份描述，是我第一次把三者摆在一起时才成立的——在那之前它们各自都「能用」。

第三份描述最隐蔽：代码里的 SQL。它不说自己需要哪些列，它只是 `INSERT INTO friends (slug, url, http_status, ...)`，隐含着「这张表已经有这些列」。没人写文档，检查器也不看代码，于是这一份长期游离在视线外。

本地首页起不来那次，现象落在页面上，很容易先去查渲染模板和 Markdown 解析。真因却是 `posts` 表在本地少了两列。结构漂移伪装成功能 bug 的时候，排查路径会被它带偏——报错发生在读数据的地方，根因写在写结构的地方，两者隔着一层。

我做的第一步不是修漂移，是承认没有版本记录，再把「哪份算数」定下来：线上库算数，`schema.sql` 和代码都得向它对齐；但线上库本身也要能被重放出来，否则换台机器就重建不了。承认这一点之后，后面所有决定都顺了。

## 二、第一次检查抓到的三处漂移

`scripts/schema.mjs check` 把三份描述两两对照，输出不是一句「通过 / 不通过」，是逐条列出差异。我把第一次实跑的四条发现原样贴在这里：前三条是描述之间的漂移，第四条是本地库自己的旧账。每条差异都点名两份来源和具体对象，不写「结构不一致」这种没法动手的结论——检查器的输出得能直接翻译成下一步动作。

| 发现 | 哪两份对不上 | 具体内容 | 后果 |
|---|---|---|---|
| 1 | `schema.sql` ↔ 代码 | `friends` 缺 `http_status` / `latency_ms` | `src/cron.js` 写这两列，`db:init` 建的库上线即 `no such column` |
| 2 | `schema.sql` ↔ 线上 | `schema.sql` 多出 `idx_pv_day` / `idx_pv_path` | 线上根本没有，等于重建出一个线上没有的结构 |
| 3 | 线上 ↔ `schema.sql` | 线上有 `idx_posts_published` / `idx_posts_series` / `idx_comments_ip` | `schema.sql` 漏记，按它重建后这三个索引消失 |
| 4 | 本地库 ↔ 线上 | 本地 `posts` 缺 `html_content` / `cover_body` | 本地首页起不来，已 `ALTER` 补上 |

第 1 条最要命，因为它不会在测试期暴露。线上库有那两列，cron 一直在写，`schema.sql` 没记；开发时谁也不会拿 `db:init` 从零建一个库再接 cron。同一份代码，在已有库上跑得好好的，换台干净机器按文档初始化，一写就炸。

本地库和线上库同名不同物这件事，[D1 报错 no such table](/p/d1-no-such-table)里拆过一次，这里撞的是它的近亲 `no such column`：不是表不存在，是列不存在。第 4 条的 `html_content` / `cover_body` 同理，本地首页起不来，真因就是这两列在本地 `posts` 上缺席，不是渲染代码写错。它在写这篇之前已经 `ALTER` 补上，我把它留在表里不是为了留案底，是因为它解释了为什么我对漂移后知后觉——本地库少两列照样能让人误以为是页面 bug。

第 2 和第 3 条方向相反，正好说明「互相漂」不是修辞：`schema.sql` 比线上多了两个索引，又比线上少了三个。从名字能猜出这些索引的意图：`idx_posts_published` 大约服务于按发布时间取列表，`idx_posts_series` 服务于系列，`idx_comments_ip` 服务于按 IP 过滤。这几个用途我没逐条跑 `EXPLAIN`，只到从命名推断为止。能确定的是，索引缺失不会当场报错，慢不慢我没量，这条没测，只到推断为止；但「按 `schema.sql` 重建线上」这个念头，从此不能成立了。

## 三、基线不是新建，是从线上导出来的

定下「线上算数」之后，基线文件的来源就明确了：不是我照着记忆重写一遍 DDL，是从线上 `sqlite_master` 把真实建表语句导出来，整理成干净、可重放的 SQL，存成 `migrations/0001_baseline.sql`。

线上 `sqlite_master` 里的原始建表语句是能跑的，但不能直接拿进 migrations。它没有 `IF NOT EXISTS`，照搬过去，存量库第一次 apply 就撞 `table already exists`。我做的整理只有两类动作：给每个 `CREATE TABLE` / `CREATE INDEX` 补上 `IF NOT EXISTS`，把导出时带的格式噪声抹平；列、类型、约束一个字不改。整理得越少，基线越像线上，越不容易再引入新分歧。「干净」在这里就指只留结构声明，不把某一时刻的数据内容掺进来。

导出时这个细节必须处理到位：所有 `CREATE` 都加 `IF NOT EXISTS`。存量库已经有这些表和索引，apply 一遍应该是 no-op；空库则一遍建齐。两种场景跑同一份文件，这是版本化能成立的前提，也是我愿意把「导出」当成基线来源的前提。

实测存量库上 apply 这一遍：**21 commands / 1.45ms**。21 条命令里绝大部分是撞到已存在对象后的空操作，1.45ms 是 wrangler 报出来的执行时间。它没改任何一行数据，唯一的实际效果是让 wrangler 在 `d1_migrations` 表里记了一笔——这笔记录就是后面所有幂等判断的依据。要确认它真是 no-op，办法是 apply 前后各 `dump` 一次比对输出；这一步是建基线时的一次性核对，我没把它做成每次发版都要跑的断言。

```sql
-- migrations/0001_baseline.sql 节选：列、类型、约束照线上 sqlite_master 原样导出
-- 这里只摘与漂移相关的声明，完整 DDL 在文件里
CREATE TABLE IF NOT EXISTS friends (
  -- 线上既有的其余列原样保留
  http_status INTEGER,
  latency_ms INTEGER
);

-- 索引同样带 IF NOT EXISTS：存量库撞到就跳过，空库才真正建
CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published);
CREATE INDEX IF NOT EXISTS idx_posts_series ON posts(series);
CREATE INDEX IF NOT EXISTS idx_comments_ip ON comments(ip);
```

空库那条路径我更在意。以前按 `db:init` 建出来的库，正是第 1 条漂移的受害方：cron 一写 `http_status` 就炸。现在空库 apply 这一遍，表和索引一次建齐，建出来的结构和线上重放出来的结构同源。同一份 migration 同时服务「已有库升级」和「新库初始化」，两条路径才不会再分叉。

从线上导出也有边界：它描述的是当前状态，不是历史。基线建好之后就不再改，0002 之后的新变更写进新文件——这样任何时间点重建出来的结构，都能按文件名顺序重放到那一刻，而不是永远取一份不断被覆盖的快照。

我犯过一个惯性错误：第一版想把 `schema.sql` 改名成 baseline 交差。改名解决不了漂移——它带着缺的两列和多出的两个索引，只会把错的东西正式化，还给它盖了个「版本化」的章。基线必须从线上导出，不能从另一份已经漂过的副本推导。

## 四、解析器只写一份

漂移能抓到，前提是「怎么读一份 SQL」只有一个答案。我差点写两个解析器：一个给 `check` 用，从线上 `sqlite_master` 读；一个给测试用，从 migration 文件读。两个解析器读同一句 `CREATE TABLE` 稍有分歧，检查就会报假阳性或者漏报，那比没有检查更糟——至少没有检查时没人信它。

两个解析器会怎么分歧不用列举也能想到：一句跨多行的 `CREATE TABLE`、一个带引号的标识符、一段注释里出现的 `CREATE`，都可能被两边读成不同结果。到时候 check 说缺列、test 说不缺，我得先判断哪个解析器错了，再判断结构错了——检查工具本身成了新的排查对象。共用一份解析器，把这个分支直接删掉。

解析器本身是纯函数：同一份输入吐出同一个结构对象，不读环境变量，不看 D1 连接状态。这份纯粹性是它能被两边共用的前提——check 拿着它去对线上，test 拿着它去对内存库，中间没有任何随上下文变化的分支。

所以 `parseSchema` 和 `mergeSchema` 都收进 `scripts/sql-schema.mjs`，`check` 和 `test` 共用。parse 把 DDL 拆成「表 → 列集合 / 索引集合」，merge 把 `0001`、`0002`……按序叠成一份期望结构。两个子命令看到的期望是同一个对象，差异只可能来自真差异，不会来自解析口径不一致。

```js
// scripts/sql-schema.mjs：check 与 test 共用这一份解析结果
import { parseSchema, mergeSchema } from './sql-schema.mjs';

const baseline = parseSchema(read('migrations/0001_baseline.sql'));
const expected = mergeSchema([
  baseline,
  parseSchema(read('migrations/0002_xxx.sql')),
]);
// expected.tables.get('friends').columns 就是唯一判据
```

merge 按文件名排序叠加，`0001` 必须排在 `0002` 前面。文件名用四位数字补零，目的就是让字典序等于版本序；到了五位数那天得换排序规则，那是很远的事，现在不管。`dump` 和 `expected` 两个子命令则是排查用的：`dump` 打线上实际结构，`expected` 打迁移叠出来的期望结构，两边各存一份贴到一起 diff，比对着报错猜快得多。

退出码在这一层分了三档，是整套东西里最需要讲清楚的设计。缺表、缺列、缺索引 → exit 1；连不上 D1 → exit 2；库里多出 migrations 没写的列 → 只 warn，不阻断。第三档我特意放宽：多出来的列可能是历史遗留，删它要单独评估，不该因为一条警告就卡住发版。

| 退出码 | 触发条件 | 检查器动作 | 发版闸门动作 |
|---|---|---|---|
| 0 | 结构一致（多出的列只 warn） | 正常结束 | 放行 |
| 1 | 缺表 / 缺列 / 缺索引 | 打印差异 | 停下发版 |
| 2 | 连不上 D1 | 打印连接失败 | 告警后放行 |

这张表是写给未来的自己的。exit 2 的「告警后放行」最容易被后人改成「一律拦住」，看着更严谨，实际把 D1 抖动变成了发版故障。

## 五、两条真正值钱的断言

`scripts/test-schema.mjs` 一共 **11 条**离线断言，进了 `npm test`。大多数是常规的形状检查，真正值钱的是下面两条——它们分别把第三份描述和重放结果纳入了机器判定。这 11 条全离线，不连 D1。能进 `npm test` 是刻意选的：发版前的检查依赖网络，本地改完想快速验证就跑不了；离线断言把反馈压到一次本地命令里。

第一条：代码里 `INSERT INTO 表 (列…)` 用到的列，必须在 migrations 里找得到。它把「代码假设有哪些列」这份一直游离的第三描述，第一次纳入了检查。前面说的 `friends.http_status` 漂移，靠的就是这一类断言兜底：就算有人再手改 `schema.sql`，只要代码还在写这一列，migrations 里缺了就红。

```js
// 断言一：抓源码里的 INSERT 列，对着 migrations 的期望结构核
const inserts = scanSqlStringLiterals(srcFiles);   // 取 `INSERT INTO x (a, b, ...)`
for (const { table, columns } of inserts) {
  const known = expected.tables.get(table)?.columns ?? new Set();
  for (const c of columns) {
    assert(known.has(c), `${table}.${c} 不在 migrations 里`);
  }
}
```

这条断言的输入不是手写的清单，是从源码里扫出来的。手写清单会过期——加一列忘了往清单里加，断言就形同虚设；从 `INSERT` 语句反推，代码怎么写，清单就怎么变。第三份描述因此第一次有了机器可读的形态，不用靠我在评审时肉眼对照。

第二条：在 `node:sqlite` 的内存库里按序重放全部迁移，把建出来的实际结构，和 `parseSchema` 解析出来的期望结构逐项比对。这条抓的是「手抄 DDL 抄漏一列」——迁移文件是人写的，人会漏；期望和实际对不上，就说明哪里漏了或者写岔了，不必等上线才炸。

```js
// 断言二：内存库重放，结果要等于解析出来的期望
const db = new Database(':memory:');
for (const f of migrationFiles) db.exec(read(f));
const actual = introspect(db);              // 从 sqlite_master 读回真实结构
assert.deepEqual(actual, expected);         // 表 / 列 / 索引逐项相等
```

用内存库而不是直接查线上，是为了让这条断言能离线跑、不依赖 D1 凭证。按序重放是关键：0002 的 `ALTER` 必须落在 0001 建好的表上，顺序错了结果就没有意义。比对的另一端是 `parseSchema` 算出来的期望，不是 `schema.sql`——`schema.sql` 自己就是被检查对象，不能让它当裁判。

两条断言的方向是相反的：第一条从代码走向 migrations，回答「写进去的列有没有地方放」；第二条从 migrations 走向真实数据库，回答「写下来的结构能不能真建出来」。漂移恰好会沿这两个方向漏出去，只堵一头另一头照样出问题，两头都查才算把路径覆盖完整。

`test-schema` 还禁止未标注的 `DROP` / `RENAME` / 删列。真要删，得在迁移文件里写 `-- @allow-destructive`，让破坏性动作显式留痕。这个标记的作用不是授权，是留痕：真出事的时候能一眼看出哪次迁移动过刀。`-- @allow-destructive` 挡的也不是手滑，是「顺手清理一下」——清理掉的列可能还有代码在写，而这个体系里没人会替你先跑一遍引用扫描。

`schema.sql` 的兼容性也靠这套断言锁住。它保留着给老脚本用，但 `test-schema` 会把它解析一遍，要求和 migrations 叠出来的期望等价——于是它再漂一次，测试就红。我没删 `schema.sql`，删了要改的调用点太多；锁住等价，比删掉省事。

## 六、SQLite 不支持的那种幂等

0002 迁移踩过一个语法坑：`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 在 SQLite 里是语法错。我下意识以为它跟 `CREATE TABLE IF NOT EXISTS` 一样，加个后缀就幂等，跑的时候被 wrangler 直接打回来。

```sql
-- 语法示意：SQLite 没有 ADD COLUMN IF NOT EXISTS 这个分支
ALTER TABLE t ADD COLUMN IF NOT EXISTS c INTEGER;   -- 语法错
ALTER TABLE t ADD COLUMN c INTEGER;                 -- 标准写法
```

原因是 `ADD COLUMN` 根本没有这个语法分支。标准写法重复执行会报 `duplicate column name`，但在这个体系里重复执行本来就不该发生——幂等不靠 SQL 语句自己扛，靠 wrangler 的 `d1_migrations` 记录：apply 过的版本号不会再 apply 第二次。

这件事把幂等的归属讲清楚了：它是整套机制的属性，不是单条语句的属性。`CREATE ... IF NOT EXISTS` 看着幂等，其实也靠 wrangler 的记录兜底，只是 SQLite 恰好给 `CREATE` 留了这个语法；`ADD COLUMN` 没留，就别在语法上硬凑，把判断统一交给 `d1_migrations` 这一层。

`test-schema` 对这件事处理得很克制：只要求 `CREATE` 系列语句带 `IF NOT EXISTS`，`ALTER` 不查这一项。检查器要有边界，把 SQLite 根本做不到的语法也列进要求，只会逼出绕过检查的写法，那比不检查还坏。

新建一次迁移的流程也定下来了，顺序不再靠记：

```bash
# 新建 migrations/NNNN_xxx.sql 之后，本地连跑两次验幂等
npm run schema:apply:local
npm run schema:apply:local
# 上线上，再检查结构
npm run schema:apply
npm run check:schema
# 过了才发版
```

这套检查有一个已知的空档：将来谁写了 `ADD COLUMN IF NOT EXISTS`，`test-schema` 不会拦，因为它只要求 `CREATE` 带 `IF NOT EXISTS`。那种写法会在 apply 的时候被 SQLite 拒掉，不会静默通过。我没写过 0003 去验证这个行为，这条按解析器规则推断，只到推断为止。

两次 `schema:apply:local` 是这个流程里最便宜的一步：第一次建结构，第二次应该什么都没做。如果第二次报错，就说明这条迁移里有没被 `d1_migrations` 接住的重复动作，多半又是某个 `ALTER`。便宜到这种程度还跳过，就没有理由了。

## 七、把检查接进发版闸门

检查写好了不接进部署，等于没有。`deploy.mjs` 里加了一道闸门，调 `check` 之后看退出码：exit 1 停下发版，提示先把 migration apply 掉；exit 2 只打警告，继续发。

分开处理这两个码有原因。exit 1 是真漂移——代码需要的列线上没有，发上去就是 500，必须拦。exit 2 是连不上 D1，可能是网络抖动、token 过期、或者 D1 正在维护；这种时候把整个发版卡住，代价大于收益，而且漂移本身并没被证明存在。我宁可带着一条警告发一版，也不要因为 D1 抖一下就停住。

```js
// deploy.mjs 里的闸门
const code = checkSchema();
if (code === 1) {
  console.error('结构漂移：先 apply migrations，再发版');
  process.exit(1);
}
if (code === 2) {
  console.warn('D1 连不上，跳过结构检查（不阻断发版）');
}
```

闸门只挡一种错：结构漂移。它不做全量测试，也不修任何东西，职责收得这么窄才敢放在发版路径上——一个想解决所有问题的前置检查，结果往往变成人人想绕过的那一步。

闸门接在 `deploy.mjs` 内部，不是单拎出来的 CI 步骤。这个站没有构建流水线，发版就是一次脚本调用；把检查塞进调用内部，才没人能绕过。独立步骤的好处是可跳过，坏处也是可跳过——我不要这个好处。

exit 1 停住之后，动作是明确的：新建或补一条 migration、本地两次 apply、上线 apply、再 check。这套顺序在上一节写过，闸门不负责教人怎么修，只负责不让人带着漂移过去。

`db:init` 和 `db:init:local` 也改了：不再直接 execute `schema.sql`，改成走 `migrations apply`。这样「初始化一个库」和「升级一个库」变成同一条路径，不会再出现「初始化出来的库和升级上来的库结构不一样」这种事——前面那三处漂移，正是两条路径分叉养出来的。

`schema.sql` 留着当兼容副本，由 `test-schema` 锁死它和 migrations 等价。它不再是真相，只是一份接受检查的影子。真要改结构，入口只有一个：新建 `migrations/NNNN_xxx.sql`。

## 怎么自己验一遍

1. 在存量库上跑 `npm run check:schema`，确认输出是通过而不是差异列表；我第一次跑抓到的是上面表格里那四条。
2. 翻 `migrations/0001_baseline.sql`，确认每条 `CREATE` 都带 `IF NOT EXISTS`；在已有库上 apply 应看到 **21 commands / 1.45ms** 这个量级的 no-op，前后各 `dump` 一次应当一致，并且 `d1_migrations` 多出一行记录。
3. 跑 `npm test`，确认 `test-schema` 的 **11 条**断言全绿。删掉某条 migration 里的一列再跑，按断言写法至少第二条会红——这个破坏性试验我没在提交 `0be25e6` 之后重做，只到推断为止。
4. 本地连跑两次 `npm run schema:apply:local`，第二次必须仍是 no-op；第二次报错就说明有 `ALTER` 没走 `d1_migrations` 的幂等路径。
5. 对 `deploy.mjs` 看退出码分支：exit 1 必须 `process.exit(1)`，exit 2 只能是 `console.warn`。断网模拟一次 exit 2、确认发版没被拦住这条我没实测，只到读代码为止。
6. 提交 `0be25e6` 之后线上跑一次 `check:live`，我这边是 73/73；数字对不上就回去 diff `dump` 与 `expected`，别直接改基线。

#d1 #sqlite #cloudflare #testing
