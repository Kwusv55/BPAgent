// 「在原生界面打开」：按 agents.json 里 native 配置拉起对应程序/终端，续接同一个会话
import { spawn } from 'node:child_process';
import { fill, resolveCommand } from './util.js';

export function openNative(agent, index, ctx) {
  if (index === 'folder') {
    spawn('explorer.exe', [ctx.cwd], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const act = agent?.native?.[index];
  if (!act) throw new Error('没有这个打开方式');
  const needsSession = act.command.some(s => s.includes('{sessionId}'));
  if (needsSession && !ctx.sessionId) throw new Error('这个任务还没有会话 id，等它开始干活后再打开');
  // {command}：agent 自己解析后的可执行文件路径（命令不在 PATH 里时用，如 Codex 桌面版自带的 CLI）
  const [cmd, ...args] = act.command.map(s => fill(s, { command: resolveCommand(agent.command) ?? agent.command, ...ctx }));
  const child = spawn(cmd, args, { cwd: ctx.cwd, detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}
