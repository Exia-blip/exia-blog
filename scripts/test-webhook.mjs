// 通知报文的平台映射：改错一处就是「配好了但群里没消息」。
// 用法：node scripts/test-webhook.mjs
import assert from 'node:assert/strict';
import { webhookPlatform, webhookPayload } from '../src/webhook.js';

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('企微 / 飞书 / Discord / Slack 各认各的域名', () => {
  assert.equal(webhookPlatform('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x'), 'wecom');
  assert.equal(webhookPlatform('https://open.feishu.cn/open-apis/bot/v2/hook/x'), 'feishu');
  assert.equal(webhookPlatform('https://open.larksuite.com/open-apis/bot/v2/hook/x'), 'feishu');
  assert.equal(webhookPlatform('https://discord.com/api/webhooks/1/x'), 'discord');
  assert.equal(webhookPlatform('https://discordapp.com/api/webhooks/1/x'), 'discord');
  assert.equal(webhookPlatform('https://hooks.slack.com/services/T/B/x'), 'slack');
});

t('不认识的域名落到 generic，不报错也不瞎猜', () => {
  assert.equal(webhookPlatform('https://example.com/hook'), 'generic');
  assert.equal(webhookPlatform(''), 'generic');
});

t('企微用 msgtype，不是 Slack 的 text', () => {
  const p = webhookPayload('https://qyapi.weixin.qq.com/x', 'hello');
  assert.deepEqual(p, { msgtype: 'text', text: { content: 'hello' } });
});

t('飞书用 msg_type + content.text', () => {
  const p = webhookPayload('https://open.feishu.cn/x', 'hello');
  assert.deepEqual(p, { msg_type: 'text', content: { text: 'hello' } });
});

t('Discord 只吃 content，多包一层就没消息', () => {
  assert.deepEqual(webhookPayload('https://discord.com/x', 'hello'), { content: 'hello' });
});

t('Slack 与通用都用 text 字段', () => {
  assert.deepEqual(webhookPayload('https://hooks.slack.com/x', 'hello'), { text: 'hello' });
  assert.deepEqual(webhookPayload('https://example.com/x', 'hello'), { text: 'hello' });
});

t('换行不被丢：多行通知要原样带过去', () => {
  const p = webhookPayload('https://qyapi.weixin.qq.com/x', 'a\nb');
  assert.equal(p.text.content, 'a\nb');
});

let pass = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${cases.length} passed`);
