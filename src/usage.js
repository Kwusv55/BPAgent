// Claude 订阅额度：优先读 claude-hud 写出的快照（display.externalUsageWritePath，和命令行 HUD 显示的一致），
// 编排台自己跑 Claude 时收到的 rate_limit_event 更新时用它。窗口已经过了重置时间的按 0 算
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expand } from './util.js';

export function claudeUsageFile(hubCfg) {
  return expand(hubCfg.claudeUsageFile || path.join(os.homedir(), '.claude', 'plugins', 'claude-hud', 'usage-snapshot.json'));
}

export function claudeUsage(registry, hubCfg) {
  const file = claudeUsageFile(hubCfg);
  let hud = null;
  try { hud = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* HUD 还没写过 */ }
  const fresh = (w) => (w && w.resetsAt && w.resetsAt < Date.now() ? { pct: 0, resetsAt: null } : w);
  const win = (w) => (w ? fresh({ pct: w.used_percentage ?? null, resetsAt: w.resets_at ? Date.parse(w.resets_at) : null }) : null);
  const q = registry.agents.filter(a => a.type === 'claude' && !a.custom).map(a => registry.quota.get(a.id)).filter(Boolean).sort((a, b) => b.at - a.at)[0];
  const qw = (w) => (w ? fresh({ pct: Math.round(w.utilization * 100), resetsAt: w.resetsAt ? w.resetsAt * 1000 : null }) : null);
  const hudAt = hud?.updated_at ? Date.parse(hud.updated_at) : 0;
  // 两边取更新的那份
  if (q && q.at > hudAt) return { source: 'run', updatedAt: q.at, fiveHour: qw(q.unifiedWindows?.five_hour), sevenDay: qw(q.unifiedWindows?.seven_day), file };
  return { source: hud ? 'hud' : null, updatedAt: hudAt || null, fiveHour: win(hud?.five_hour), sevenDay: win(hud?.seven_day), file };
}

// 额度压力：5 小时和 7 天里用得更多的那个百分比；没有数据按 0
export function pressureOf(u) {
  return Math.max(u?.fiveHour?.pct ?? 0, u?.sevenDay?.pct ?? 0);
}
