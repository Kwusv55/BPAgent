// 任务模板：常用的「组长 + 队员 + 约定」组合，存在 config/templates.json
import fs from 'node:fs';
import { uid } from './util.js';

const FIELDS = ['name', 'description', 'goal', 'guidance', 'leaderId', 'memberIds', 'policy', 'isolation', 'maxRounds', 'maxParallel', 'finalReview'];

export class Templates {
  constructor(file) {
    this.file = file;
  }

  list() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')).templates ?? [];
    } catch {
      return [];
    }
  }

  // 同名覆盖，否则新增
  save(input) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new Error('模板名不能为空');
    const list = this.list();
    const tpl = Object.fromEntries(FIELDS.filter(k => input[k] !== undefined && input[k] !== '').map(k => [k, input[k]]));
    const i = list.findIndex(t => t.id === input.id || t.name === name);
    if (i >= 0) list[i] = { ...list[i], ...tpl, id: list[i].id };
    else list.push({ id: uid('tpl-'), ...tpl });
    this._write(list);
    return list;
  }

  remove(id) {
    this._write(this.list().filter(t => t.id !== id));
  }

  _write(templates) {
    fs.writeFileSync(this.file, JSON.stringify({ templates }, null, 2) + '\n');
  }
}
