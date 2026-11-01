// worktree 隔离用到的 git 操作。所有提交都用固定身份，不依赖用户的 git config
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ID = ['-c', 'user.name=agent-hub', '-c', 'user.email=agent-hub@localhost'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, windowsHide: true, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`git ${args[0]} 失败：${(stderr || err.message).trim().slice(0, 400)}`), { stdout, stderr }));
      else resolve(stdout);
    });
  });
}

export const isRepo = (dir) => git(dir, ['rev-parse', '--is-inside-work-tree']).then(o => o.trim() === 'true', () => false);
export const topLevel = (dir) => git(dir, ['rev-parse', '--show-toplevel']).then(s => path.resolve(s.trim()));
export const currentBranch = (dir) => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).then(s => s.trim());
export const isDirty = (dir) => git(dir, ['status', '--porcelain', '--untracked-files=no']).then(s => s.trim().length > 0);

export async function init(dir) {
  await git(dir, ['init', '-q']);
  // 编排台自建的仓库没有 .gitignore，先把常见的运行产物排除掉，免得被 add -A 提交进去
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\n__pycache__/\n*.pyc\nnode_modules/\n.venv/\nvenv/\n.pytest_cache/\n.DS_Store\nThumbs.db\n');
}

export async function ensureCommit(dir) {
  try {
    return (await git(dir, ['rev-parse', 'HEAD'])).trim();
  } catch {
    await git(dir, [...ID, 'commit', '-q', '--allow-empty', '-m', 'agent-hub: 初始化仓库']);
    return (await git(dir, ['rev-parse', 'HEAD'])).trim();
  }
}

export const addWorktree = (repo, dir, branch, start) => git(repo, ['worktree', 'add', '-q', '-B', branch, dir, start]);

// Windows 上子进程刚退出时文件可能还被占着，多试几次
export async function removeWorktree(repo, dir) {
  for (let i = 0; i < 4; i++) {
    try {
      await git(repo, ['worktree', 'remove', '--force', dir]);
      return true;
    } catch {
      if (!fs.existsSync(dir)) break;
      await sleep(1500);
    }
  }
  await git(repo, ['worktree', 'prune']).catch(() => {});
  return !fs.existsSync(dir);
}

export const deleteBranch = (repo, branch) => git(repo, ['branch', '-D', branch]).catch(() => {});

// 返回仍带冲突标记的文件
export async function conflictMarkers(dir) {
  try {
    return (await git(dir, ['grep', '-l', '-E', '^(<<<<<<<|>>>>>>>) '])).trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return []; // git grep 没匹配时退出码为 1
  }
}

export async function commitAll(dir, message) {
  await git(dir, ['add', '-A']);
  const changed = (await git(dir, ['status', '--porcelain'])).trim();
  const merging = await git(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false);
  if (changed || merging) await git(dir, [...ID, 'commit', '-q', '--no-verify', '-m', message]);
}

export const ahead = async (cwd, base, branch) => Number((await git(cwd, ['rev-list', '--count', `${base}..${branch}`])).trim()) > 0;

export async function merge(cwd, branch, message, { ffFirst = false } = {}) {
  if (ffFirst) {
    try {
      await git(cwd, ['merge', '--ff-only', '-q', branch]);
      return { ok: true };
    } catch { /* 不能快进就走普通合并 */ }
  }
  try {
    await git(cwd, [...ID, 'merge', '--no-ff', '-q', '-m', message, branch]);
    return { ok: true };
  } catch (e) {
    const files = (await git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim().split(/\r?\n/).filter(Boolean);
    await git(cwd, ['merge', '--abort']).catch(() => {});
    return { ok: false, files, error: e.message };
  }
}

// 把集成分支合进队员分支但不提交：冲突标记留在队员的工作区里，让它自己解决
export async function mergeNoCommit(cwd, branch) {
  try { await git(cwd, [...ID, 'merge', '--no-ff', '--no-commit', branch]); } catch { /* 有冲突是预期的 */ }
}

// 组长只读不写；万一它在集成工作区留了文件，合并前清掉，避免挡住合并
export async function cleanTree(dir) {
  await git(dir, ['reset', '-q', '--hard', 'HEAD']);
  await git(dir, ['clean', '-q', '-fd']);
}
