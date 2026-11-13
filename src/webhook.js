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

export async function notifyComment(env, { postTitle, postUrl, name, content }) {
  const hook = env.WEBHOOK_URL;
  if (!hook) return;

  const plain = [`💬 新评论 · ${postTitle}`, `${name}：${String(content).slice(0, 300)}`, postUrl ? `🔗 ${postUrl}` : '']
    .filter(Boolean)
    .join('\n');

  try {
    const r = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookPayload(hook, plain)),
      signal: AbortSignal.timeout(8000),
    });
    /* 只看「fetch 没抛异常」是不够的：企微地址失效时回的是 HTTP 200 +
       {"errcode":93000,"errmsg":"invalid webhook url"}，飞书也是 200 + code≠0。
       不判这一层，通知挂了永远发现不了——评论照收，群里没消息，谁也不会怀疑到这里。
       日志进 wrangler tail，不影响评论本身的返回。 */
    if (!r.ok) {
      console.error(`[webhook] HTTP ${r.status}`);
      return;
    }
    const body = await r.text();
    let code = 0;
    try {
      const d = JSON.parse(body);
      code = Number(d.errcode ?? d.code ?? d.StatusCode ?? 0);
    } catch {}
    if (code) console.error(`[webhook] 平台返回错误 ${code}：${body.slice(0, 200)}`);
  } catch (e) {
    console.error('webhook failed:', e.message);
  }
}
