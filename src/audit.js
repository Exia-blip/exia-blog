// 后台操作审计：只增不改。审计是旁路——写失败只记日志，绝不阻断文章保存、审核等主流程。
// 所有调用方（api.js 等）都只管调，不用 try/catch 包一层。

/** detail 可能是字符串或任意对象，统一压成一行短文本再入库。 */
function detailText(detail) {
  if (detail == null) return '';
  let s;
  if (typeof detail === 'string') {
    s = detail;
  } else {
    try {
      s = JSON.stringify(detail);
    } catch {
      // 循环引用之类的脏对象：留空也不让主流程挂掉
      s = '';
    }
  }
  return String(s ?? '').slice(0, 500);
}

/**
 * 记一条后台操作。
 * @param env      Worker 环境，取 env.DB
 * @param user     当前用户；null 记为 system / 0
 * @param action   动作名，如 post.update / comment.approve
 * @param targetType 对象类型，如 post / comment / friend
 * @param targetId   对象 id（数字或字符串都接受）
 * @param detail    人读的短描述，对象会被 JSON.stringify
 */
export async function logAudit(env, user, action, targetType, targetId, detail) {
  try {
    const actorId = user?.id || 0;
    const actorLogin = user?.login || user?.name || 'system';
    await env.DB.prepare(
      'INSERT INTO audit_log (actor_id, actor_login, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(
        actorId,
        String(actorLogin).slice(0, 120),
        String(action ?? '').slice(0, 120),
        String(targetType ?? '').slice(0, 60),
        String(targetId ?? '').slice(0, 60),
        detailText(detail)
      )
      .run();
  } catch (e) {
    console.error('audit', e?.message || e);
  }
}
