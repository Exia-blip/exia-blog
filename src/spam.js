// 垃圾评论打分：给定时任务一个「可解释的删除理由」，而不是一个黑箱布尔值。
//
// 为什么是打分而不是单条正则：单条正则删错一次就够让人不敢再开自动清理。
// 每条规则单独看都有误杀面，叠起来才够可信 —— 所以判据是「总分 ≥ 阈值」，
// 且每次删除都把命中的规则写进 audit_log，事后能一眼看出「为什么删的」。
//
// 阈值定在 4，意味着下面任何一条都删不动一条正常评论：
//   · 正常中文短评「好文」        → 过短 2 分，不删
//   · 带一个链接的真评论          → 链接 1 分，不删
//   · 纯英文 "Thanks for this"    → 0 分，不删
// 而实测抓到的韩文垃圾「현정 상」→ 过短 2 + 非中文极短 2 = 4，删。
//
// 规则只在「机械可判定」的形状上生效（链接数、字符类别、长度、推广词）。
// 语意级判断（这条评论是不是人话）不做 —— 那种判据在这套结构里没有可靠输入。

const LINK_RE = /https?:\/\/\S+|www\.\S+/gi;

/* 推广词：选的是「正常评论几乎不会出现、出现了也基本是广告」的词。
   故意不收「便宜」「推荐」这类泛词 —— 它们在中文本站评论里太常见。 */
const SPAM_WORDS = [
  '加微信', '加薇信', '加v信', '加qq', '加企鹅', '私聊我', '薇信',
  '代开发票', '办证', '贷款', '博彩', '赌场', '彩票', '棋牌', '六合彩',
  '一夜情', '约炮', '成人片', '空投', '稳赚', '日赚', '刷单', '兼职日结',
  'viagra', 'casino', 'porn', 'escort', 'payday loan', 'bitcoin giveaway',
];
const WORD_RE = new RegExp(SPAM_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

/* 短链与 IM 跳转：正文里出现它们，几乎只有推广一种用途 */
const DODGY_LINK_RE = /(?:t\.me|wa\.me|bit\.ly|tinyurl\.com|goo\.gl|is\.gd|t\.cn)\//i;

const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const LETTER_NUM_RE = /[\p{L}\p{N}]/u;

export const SPAM_MIN_SCORE = 4;

/**
 * @param {{content?: string}} c
 * @returns {{score: number, reasons: string[]}}
 */
export function spamScore(c = {}) {
  const raw = String(c.content || '');
  const links = raw.match(LINK_RE) || [];
  const rest = raw.replace(LINK_RE, '').replace(/\s+/g, '');
  const reasons = [];
  const add = (name, n) => reasons.push(`${name}+${n}`);

  if (links.length) {
    /* 正文除了链接什么都不剩：链接本身就是全部内容。
       4 分是刻意给满的 —— 单发一条链接的评论没有第二种解释。 */
    if (rest.length <= 2) add('只有链接', 4);
    else if (links.length >= 3) add('链接过多', 3);
    else if (links.length === 2) add('两个链接', 2);
    if (DODGY_LINK_RE.test(raw)) add('短链/IM', 2);
    /* 三个以上链接 + 正文只剩几个字：推广的典型形状。
       不把「三个链接」本身给满分，是因为有人真会贴三条出处 —— 那种评论
       正文一定长，落不进这一条。 */
    if (links.length >= 3 && rest.length <= 6) add('几乎只有链接', 2);
  }

  const word = raw.match(WORD_RE);
  if (word) add(`推广词:${word[0]}`, 3);

  if (!links.length && rest.length <= 3) add('过短', 2);

  /* 非中文的极短评论：本站是中文博客，一行韩文/符号砸进来的形状就是垃圾。
     上限压在 6 个字符，是为了不误杀「Thanks」「nice post」这类外文短评
     （它们有 ≥2 个拉丁字母，不进这一条）。 */
  const latin = (rest.match(/[A-Za-z]/g) || []).length;
  if (!links.length && rest.length <= 6 && !HAN_RE.test(rest) && latin < 2) add('非中文极短', 2);

  /* 纯标点：只认标点类（\p{P}），不认 emoji（\p{S}）——「👍👍」是有人在回话，
     「!!!!????」不是。长度门槛 4 是为了放过「……」「?」这种真反应。 */
  if (rest.length >= 4 && !LETTER_NUM_RE.test(rest) && /^[\p{P}\p{Z}\s]+$/u.test(rest)) add('纯标点', 4);

  const score = reasons.reduce((n, r) => n + Number(r.split('+').pop()), 0);
  return { score, reasons };
}

export const isSpam = (c, min = SPAM_MIN_SCORE) => spamScore(c).score >= min;
