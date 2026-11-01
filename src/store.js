// 编排记录持久化：data/runs/<runId>/run.json + events.jsonl（原始事件流，读取时再合并）
import fs from 'node:fs';
import path from 'node:path';
import { mergeEvent } from './util.js';

export class Store {
  constructor(dir) {
    this.dir = path.join(dir, 'runs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.runs = new Map();
    this.events = new Map();   // runId → Map(taskId → 合并后的事件数组)
    this.streams = new Map();
    this.timers = new Map();
    this._load();
  }

  _load() {
    for (const id of fs.readdirSync(this.dir)) {
      try {
        const run = JSON.parse(fs.readFileSync(path.join(this.dir, id, 'run.json'), 'utf8'));
        // 上次没跑完的编排：进程已经没了，标记中断
        // 记下原状态，「继续运行」时据此恢复
        if (!['done', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
          run.status = 'interrupted';
          run.leaderWaitUntil = null;
          for (const t of run.tasks) {
            t.waitUntil = null;
            if (['running', 'review'].includes(t.status)) { t.prevStatus = t.status; t.status = 'interrupted'; }
          }
        }
        this.runs.set(run.id, run);
      } catch { /* 损坏的目录跳过 */ }
    }
  }

  list() {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  save(run, immediate = false) {
    this.runs.set(run.id, run);
    clearTimeout(this.timers.get(run.id));
    const write = () => {
      fs.mkdirSync(path.join(this.dir, run.id), { recursive: true });
      fs.writeFileSync(path.join(this.dir, run.id, 'run.json'), JSON.stringify(run, null, 1));
    };
    if (immediate) write();
    else this.timers.set(run.id, setTimeout(write, 300));
  }

  addEvent(runId, taskId, ev) {
    const list = this._taskEvents(runId, taskId);
    mergeEvent(list, ev);
    let s = this.streams.get(runId);
    if (!s) {
      fs.mkdirSync(path.join(this.dir, runId), { recursive: true });
      s = fs.createWriteStream(path.join(this.dir, runId, 'events.jsonl'), { flags: 'a' });
      this.streams.set(runId, s);
    }
    s.write(JSON.stringify({ taskId, ...ev }) + '\n');
  }

  getEvents(runId, taskId) {
    return this._taskEvents(runId, taskId);
  }

  _taskEvents(runId, taskId) {
    if (!this.events.has(runId)) {
      const byTask = new Map();
      const file = path.join(this.dir, runId, 'events.jsonl');
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line) continue;
          try {
            const { taskId: tid, ...ev } = JSON.parse(line);
            if (!byTask.has(tid)) byTask.set(tid, []);
            mergeEvent(byTask.get(tid), ev);
          } catch { /* 半行 */ }
        }
      }
      this.events.set(runId, byTask);
    }
    const byTask = this.events.get(runId);
    if (!byTask.has(taskId)) byTask.set(taskId, []);
    return byTask.get(taskId);
  }

  remove(runId) {
    this.streams.get(runId)?.end();
    this.streams.delete(runId);
    this.events.delete(runId);
    this.runs.delete(runId);
    fs.rmSync(path.join(this.dir, runId), { recursive: true, force: true });
  }
}
