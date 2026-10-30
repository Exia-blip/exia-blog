// 新评论通知：按目标域名生成对应平台的结构，四个平台全兼容
export async function notifyComment(env, { postTitle, postUrl, name, content }) {
  const hook = env.WEBHOOK_URL;
  if (!hook) return;

  const plain = [`💬 新评论 · ${postTitle}`, `${name}：${String(content).slice(0, 300)}`, postUrl ? `🔗 ${postUrl}` : '']
    .filter(Boolean)
    .join('\n');

  let payload;

  if (hook.includes('qyapi.weixin.qq.com')) {
    // 企业微信机器人
    payload = { msgtype: 'text', text: { content: plain } };
  } else if (hook.includes('open.feishu.cn') || hook.includes('open.larksuite.com')) {
    // 飞书自定义机器人
    payload = { msg_type: 'text', content: { text: plain } };
  } else if (hook.includes('discord.com') || hook.includes('discordapp.com')) {
    // Discord
    payload = { content: plain };
  } else {
    // Slack 及通用
    payload = { text: plain };
  }

  try {
    await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error('webhook failed:', e.message);
  }
}
