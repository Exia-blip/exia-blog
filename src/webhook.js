// 新评论通知：按目标域名生成对应平台的结构，四个平台全兼容

/* 平台判定单独抽出来，是为了让 scripts/setup-webhook.mjs 能用同一套规则做预检。
   手抄一份「企微用 msgtype、飞书用 msg_type」到脚本里，改了一处忘了另一处，
   表现是「配好了但消息发不出」，而且脚本还会显示成功。 */
export function webhookPlatform(hook = '') {
  if (hook.includes('qyapi.weixin.qq.com')) return 'wecom';
  if (hook.includes('open.feishu.cn') || hook.includes('open.larksuite.com')) return 'feishu';
  if (hook.includes('discord.com') || hook.includes('discordapp.com')) return 'discord';
  if (hook.includes('hooks.slack.com')) return 'slack';
  return 'generic';
}

export function webhookPayload(hook, plain) {
  switch (webhookPlatform(hook)) {
    case 'wecom':
      return { msgtype: 'text', text: { content: plain } };
    case 'feishu':
      return { msg_type: 'text', content: { text: plain } };
    case 'discord':
      return { content: plain };
    default:
      // Slack 与通用：Slack 也吃 { text }
      return { text: plain };
  }
}

/* 返回投递结果，交给调用方落库：{ status, note }
   status: ok 平台已接受 / fail HTTP 或平台码非 0 / skip 没配地址
   只在返回「平台接受」时才是 ok —— fetch 没抛异常不等于送达，企微那种
   200 里塞 errcode 的情况必须算 fail，否则后台那一列会把失败显示成成功。 */
async function sendWebhook(env, plain) {
  const hook = env.WEBHOOK_URL;
  if (!hook) return { status: 'skip', note: '未配置 WEBHOOK_URL' };

  try {
    const r = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookPayload(hook, plain)),
      signal: AbortSignal.timeout(8000),
    });
    /* 只看「fetch 没抛异常」是不够的：企微地址失效时回的是 HTTP 200 +
       {"errcode":93000,"errmsg":"invalid webhook url"}，飞书也是 200 + code≠0。
       不判这一层，通知挂了永远发现不了——评论照收，群里没消息，谁也不会怀疑到这里。 */
    if (!r.ok) {
      console.error(`[webhook] HTTP ${r.status}`);
      return { status: 'fail', note: `HTTP ${r.status}` };
    }
    const body = await r.text();
    let code = 0;
    try {
      const d = JSON.parse(body);
      code = Number(d.errcode ?? d.code ?? d.StatusCode ?? 0);
    } catch {}
    if (code) {
      console.error(`[webhook] 平台返回错误 ${code}：${body.slice(0, 200)}`);
      return { status: 'fail', note: `平台码 ${code}` };
    }
    return { status: 'ok', note: '' };
  } catch (e) {
    console.error('webhook failed:', e.message);
    return { status: 'fail', note: String(e.message || '请求失败').slice(0, 80) };
  }
}

/* 新评论的文案只有这一份。补发（/api/comments/notify）走的是同一个函数，
   所以「重投一次」和「第一次推送」内容必然一致 —— 两份模板的结果是
   补发出去的消息缺一截，而两条路径都不会报错。 */
export function commentNotice({ postTitle, postUrl, name, content }) {
  return [`💬 新评论 · ${postTitle}`, `${name}：${String(content).slice(0, 300)}`, postUrl ? `🔗 ${postUrl}` : '']
    .filter(Boolean)
    .join('\n');
}

export async function notifyComment(env, { postTitle, postUrl, name, content }) {
  return await sendWebhook(env, commentNotice({ postTitle, postUrl, name, content }));
}

/* 一条评论该发哪种通知：待审走待办提醒，其余走新评论推送。
   发评论与补发都必须经过这里 —— 补发时若自己判断状态，pending 的评论会被
   当成「已发布的新评论」推进群，等于把没通过的稿子预告出去。 */
export async function notifyForComment(env, { status, postTitle, postUrl, adminUrl, name, content }) {
  if (status === 'pending') {
    return await notifyTodo(env, `新评论待审：${name} 在《${postTitle}》\n${adminUrl}`);
  }
  return await notifyComment(env, { postTitle, postUrl, name, content });
}

/** 后台待办提醒：待审稿、友链挂掉。复用评论通知的同一个 webhook 与平台适配。 */
export async function notifyTodo(env, text) {
  return await sendWebhook(env, `[待办] ${String(text).slice(0, 500)}`);
}
