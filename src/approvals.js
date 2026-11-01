// 审批收件箱：ACP 的 request_permission 和 Claude 的 permission-prompt-tool 都汇到这里
import { EventEmitter } from 'node:events';
import { uid, now } from './util.js';

export class Approvals extends EventEmitter {
  constructor() {
    super();
    this.items = new Map();
  }

  // 返回 {id, promise}；promise 解析为 {allow, message}
  open({ runId, taskId, agentId, title, input }) {
    const item = { id: uid('a'), runId, taskId, agentId, title, input, createdAt: now(), status: 'pending' };
    item.promise = new Promise(res => { item.resolve = res; });
    this.items.set(item.id, item);
    this.emit('change');
    return item;
  }

  decide(id, allow, message) {
    const item = this.items.get(id);
    if (!item || item.status !== 'pending') return false;
    item.status = allow ? 'allowed' : 'denied';
    item.resolve({ allow, message });
    this.emit('change');
    // 留一会儿给长轮询取结果，再清掉
    setTimeout(() => this.items.delete(id), 120_000);
    return true;
  }

  // 编排或任务被取消时，把挂着的审批一并拒掉
  denyWhere(pred, message) {
    for (const it of this.items.values()) if (it.status === 'pending' && pred(it)) this.decide(it.id, false, message);
  }

  async wait(id, ms = 25_000) {
    const item = this.items.get(id);
    if (!item) return { decided: true, allow: false, message: '审批已过期' };
    const r = await Promise.race([item.promise, new Promise(res => setTimeout(() => res(null), ms))]);
    return r ? { decided: true, ...r } : { decided: false };
  }

  pending() {
    return [...this.items.values()].filter(i => i.status === 'pending')
      .map(({ promise, resolve, ...rest }) => rest);
  }
}
