// 组长 / 队员的提示词模板。组长的结构化输出一律用 ```json 代码块，便于解析。
import { clip } from './util.js';

const STATUS = { pending: '待开始', running: '进行中', review: '待审查', done: '已完成', failed: '失败', skipped: '已跳过', cancelled: '已取消', interrupted: '已中断' };

// 档位：决定按难度派给谁（agents.json 的 tier）。专家最贵，只接难题
export const TIER = { cheap: '经济型', main: '主力', expert: '专家' };
const LEVEL = { easy: '简单', normal: '常规', hard: '困难' };

const roster = (agents) => agents.map(a =>
  `- id=${a.id}｜${a.name}｜档位：${TIER[a.tier] ?? '主力'}｜${a.description || '（无说明）'}｜同时最多 ${a.maxConcurrent} 个任务`).join('\n');

const taskTable = (run) => run.tasks.length
  ? run.tasks.map(t => `- ${t.id}「${t.title}」→ ${t.assignee}｜${LEVEL[t.level] ?? '常规'}｜${STATUS[t.status] ?? t.status}${t.deps.length ? `｜依赖 ${t.deps.join(',')}` : ''}`).join('\n')
  : '（暂无任务）';

const TASK_SCHEMA = `{"id":"t1","title":"简短标题","assignee":"队员id","level":"easy / normal / hard","deps":[],"prompt":"给队员的完整说明，含验收标准"}`;

// 分工原则：按难度分档派活，专家（Claude）只做最值钱的部分。budget 是编排器算好的专家额度状态
function routing(run, members, budget) {
  const has = (tier) => members.some(m => (m.tier ?? 'main') === tier);
  const lines = [
    '每个任务都要标 level，并按档位派给队员：',
    `- easy：机械改动、批量替换、格式转换、写文档和注释、补测试用例、收集资料、做 Office 文件 → ${has('cheap') ? '经济型' : '主力'}队员`,
    '- normal：常规功能实现、重构、普通 bug、接口对接、跑测试和修测试 → 主力队员',
    `- hard：架构和接口设计、跨模块的疑难 bug 定位、并发 / 性能 / 安全问题、其他队员已经失败过的问题 → ${has('expert') ? '专家' : '主力'}队员`,
  ];
  if (has('expert')) {
    lines.push('专家的额度最贵、最有限：只派 hard 任务，一次编排一般 0～2 个。派给它的任务要聚焦在最难判断的那一步（定位根因、定方案、写核心代码），外围的实现、测试、文档拆出去给其他队员。');
    if (run.finalReview) lines.push('全部任务完成后，编排台会自动安排专家做一次整体终审，你不需要另外加审查任务。');
    if (budget?.blocked) lines.push(`⚠ 专家当前额度已用尽（${budget.blocked}恢复）：不要派给它，hard 任务交给主力队员。`);
    else if (budget?.tight) lines.push(`⚠ 专家当前额度紧张（${budget.text}）：除非确实只有它能做，否则不要派给它；非 hard 任务派给它会被编排台自动改派。`);
    else if (budget?.text) lines.push(`专家当前额度：${budget.text}。`);
  }
  return lines.join('\n');
}

const workspaceNote = (run, cwd) => run.git
  ? `${cwd}
（这是 git 分支 ${run.git.branch} 的集成工作区，里面是已经验收合并的成果。每个队员会在自己独立的 git worktree 里并行工作，验收通过后由编排台合并进来。你可以读这里的文件、运行只读命令，但不要修改。）`
  : `${cwd}
（所有队员共享这个目录；你可以读里面的文件了解现状，但不要修改。）`;

export function plan(run, members, cwd, budget) {
  return `你是一个多智能体团队的【组长】。你的职责只有规划、派活、审查和汇总，**不要自己动手做任务**（不要写代码、不要改文件）。

## 用户目标
${run.goal}
${run.guidance ? `\n## 团队约定（用户指定，必须遵守）\n${run.guidance}\n` : ''}
## 工作目录
${workspaceNote(run, cwd)}

## 可用队员
${roster(members)}

## 分工原则
${routing(run, members, budget)}

## 你要输出的东西
把目标拆成 1～8 个子任务，每个派给最合适的队员：
- 队员**看不到**这段对话，也看不到其他任务的说明，只能看到你写的 prompt 和它所依赖任务的结果汇报，所以 prompt 必须自包含、写清楚验收标准。
- 能并行的任务不要加依赖；有先后关系的用 deps 写上前置任务的 id。前置任务验收后，它的成果才对后续任务可见。
- 并行的任务尽量不要改同一个文件${run.git ? '（各自在独立 worktree 里，同一文件的改动合并时可能冲突）' : ''}。
- 任务粒度以“一个队员十几分钟能做完”为宜；简单目标一个任务就够了，别为了拆而拆。
- 按上面的分工原则和队员的特长派活，能用便宜的队员做好的就不要派给贵的。

最后只输出一个 JSON 代码块：
\`\`\`json
{"analysis":"一两句话说明拆分思路","tasks":[${TASK_SCHEMA}]}
\`\`\``;
}

export function task(run, t, member, deps, cwd) {
  const depText = deps.length
    ? deps.map(d => `### ${d.id}「${d.title}」（${d.assignee}，${STATUS[d.status] ?? d.status}）\n${clip(d.result || d.error || '（无汇报）', 2500)}`).join('\n\n')
    : '（无）';
  return `你是团队里的队员（${member.name}），组长派给你一个任务。

工作目录：${cwd}
${run.git ? `（这是你独立的 git worktree，分支 ${t.branch}，已包含此前验收通过的成果。只管修改文件，**不要执行 git commit、切换分支、merge 等 git 写操作**，提交和合并由编排台负责。）\n` : ''}
## 任务 ${t.id}：${t.title}
${t.prompt}

## 前置任务的结果
${depText}

## 要求
- 直接动手完成，不要反问。遇到不确定的地方按最合理的假设去做，并在汇报里说明。
- 遇到靠自己解决不了的阻塞（需求有歧义且会影响结果、缺少必要的信息或权限、和其他任务冲突），调用 \`ask_leader\` 工具向组长提问，拿到回答后继续。小事不要问。如果没有这个工具，就按最合理的假设做完，并在汇报开头写「阻塞：」说明问题。
- 只改和本任务相关的文件。
- 做完后用简短中文汇报：做了什么、改了哪些文件、怎么验证的、有什么遗留问题。`;
}

export function revise(t) {
  return `组长审查后要求返工（第 ${t.rounds} 轮）：

${t.feedback}

请据此修改，完成后重新汇报。`;
}

// 编排台重启后续接原会话时，用这句话让队员接着做
export function continueTask(t) {
  return `刚才编排台中断了，现在恢复。请先检查工作目录里任务「${t.title}」已经完成的部分，然后接着把它做完，最后照常汇报：做了什么、改了哪些文件、怎么验证的、有什么遗留问题。`;
}

export const RESUMED_NOTE = '\n\n## 注意\n这个任务之前执行到一半被中断了，工作目录里可能已经有部分成果。请先检查现状再继续，不要从头重复。';

export function quotaResume(text) {
  return `（额度已恢复）刚才因为额度用完而中断。如果上一轮已经做了一部分，请先检查已完成的部分再接着做。原请求如下：

${text}`;
}

export function conflict(t, files, branch) {
  return `编排台把你的改动合并进集成分支 ${branch} 时，和其他队员已合并的成果发生了冲突。最新的集成结果已经合进你的工作区，以下文件里有冲突标记（<<<<<<< / ======= / >>>>>>>）：
${files.map(f => `- ${f}`).join('\n') || '- （请全局搜索冲突标记）'}

请逐个解决冲突：同时保留双方的意图，删掉所有冲突标记，确认能正常运行。不要执行任何 git 命令。完成后重新汇报。`;
}

export function review(run, t) {
  return `队员 ${t.assignee} 交付了任务 ${t.id}「${t.title}」（第 ${t.rounds + 1} 轮）。

## 任务说明
${t.prompt}

## 队员汇报
${clip(t.result || '（空）', 6000)}
${t.worktree ? `\n## 队员的工作区\n${t.worktree}\n（改动还没提交，可以直接读这个目录里的文件，也可以在该目录运行 git status / git diff 查看相对集成分支的改动。）\n` : ''}
## 当前全部任务
${taskTable(run)}

${t.kind === 'final'
    ? `这是专家的整体终审报告。终审本身请直接 accept；报告里它没能顺手修掉的严重问题，用 newTasks 追加修复任务，按分工原则派给主力或经济型队员（除非问题只有专家能解决，否则不要再派给专家）。只是风格、措辞之类的小意见不用追加。`
    : `请审查。你可以读文件、跑只读命令核实，但不要修改文件。返工最多 ${run.maxRounds} 轮。`}
只输出一个 JSON 代码块：
\`\`\`json
{"decision":"accept 或 revise","feedback":"选 revise 时写给队员的具体修改意见","newTasks":[]}
\`\`\`
newTasks 可选：发现还需要追加的任务时填写，格式同 ${TASK_SCHEMA}，同样按分工原则标 level、选队员。`;
}

// 全部任务结束后由编排台自动追加的专家终审：一次看完整体改动，小问题顺手修，大问题列给组长
export function finalReview(run) {
  const done = run.tasks.filter(t => t.status === 'done');
  const where = run.git
    ? `工作目录已经包含本次编排所有验收合并的成果。先运行 \`git diff --stat ${run.git.base}..HEAD\` 看改了哪些文件，再用 \`git diff ${run.git.base}..HEAD -- <文件>\` 看具体改动。`
    : '各任务改了哪些文件见下面的汇报，直接读这些文件。';
  return `请对整个编排的成果做一次终审。

## 用户目标
${run.goal}

## 已完成的任务
${done.map(t => `### ${t.id}「${t.title}」（${t.assignee}）\n${clip(t.result || '', 800)}`).join('\n\n')}

## 怎么看改动
${where}

## 审查重点
只看会出问题的地方：功能是否真正满足用户目标、有没有逻辑错误和边界情况遗漏、安全隐患、明显的性能问题、测试是否真的覆盖并能通过。命名、格式、措辞这类风格问题不用提。
先看改动本身，必要时再读相关上下文，不要通读整个仓库。

## 处理方式
- 小问题（每处几行就能改好、不影响设计）：直接修好，并在汇报里列出改了什么。
- 大问题：不要动手，列出来，每条写清楚位置、问题、为什么严重、建议怎么修。组长会把它们派给其他队员。
- 没有发现严重问题就直接说“终审通过”，别为了凑数挑刺。

汇报用简短中文，按严重程度排序。`;
}

export function reviewFailure(run, t, members) {
  return `任务 ${t.id}「${t.title}」在队员 ${t.assignee} 那里执行失败：

${clip(t.error, 2000)}

## 可用队员
${roster(members)}

## 当前全部任务
${taskTable(run)}

请决定怎么处理。如果是能力问题（不是网络、额度之类的临时故障），重试时可以换给更高档位的队员；专家额度紧张时优先换主力队员。只输出一个 JSON 代码块：
\`\`\`json
{"decision":"retry 或 skip","assignee":"retry 时换给哪个队员（可以不换）","feedback":"retry 时给队员的补充说明","newTasks":[]}
\`\`\``;
}

export function userMessage(run, text) {
  return `用户插话了：

${text}

## 当前全部任务
${taskTable(run)}

请据此调整。只输出一个 JSON 代码块：
\`\`\`json
{"reply":"给用户的简短回复","newTasks":[],"cancel":["要取消的、还没开始的任务 id"]}
\`\`\`
newTasks 格式同 ${TASK_SCHEMA}，按分工原则标 level、选队员；不需要调整时两个数组都留空。`;
}

export function summary(run) {
  const where = !run.git ? `成果在工作目录 ${run.workdir}。`
    : run.git.merged ? `所有成果已合并到工作目录 ${run.workdir}（分支 ${run.git.mergedInto}）。`
      : `所有成果在 git 分支 ${run.git.branch} 上，还没有合并到工作目录 ${run.workdir} 的当前分支，用户可以在编排台点「合并到工作目录」。`;
  return `全部任务都结束了。${where}

${run.tasks.map(t => `### ${t.id}「${t.title}」→ ${t.assignee}｜${STATUS[t.status] ?? t.status}${t.note ? `（${t.note}）` : ''}\n${clip(t.result || t.error || '', 1200)}`).join('\n\n')}

请给用户写一份最终汇报（中文、简洁）：目标完成得怎样、产出了哪些文件、成果在哪里、还有哪些遗留问题和建议。这次不要输出 JSON。`;
}

// 队员执行中通过 ask_leader 工具提的问题
export function memberQuestion(run, t, question) {
  return `队员 ${t?.assignee ?? '?'} 在执行任务 ${t?.id ?? '?'}「${t?.title ?? ''}」时遇到阻塞，向你提问：

${question}

## 当前全部任务
${taskTable(run)}

请直接给出简短、可执行的回答。必要时可以读文件核实，但不要修改文件。只回答问题本身，这次不要输出 JSON。`;
}

// 编排进行中换了组长：把目标和进度交给新组长
export function handover(run, members, budget) {
  return `你接替前任组长，继续领导一个进行中的编排。你的职责只有规划、派活、审查、回答队员的问题和汇总，**不要自己动手做任务**。

## 用户目标
${run.goal}
${run.guidance ? `\n## 团队约定\n${run.guidance}\n` : ''}
## 拆分思路（前任组长）
${run.analysis ?? '（无）'}

## 队员
${roster(members)}

## 分工原则
${routing(run, members, budget)}

## 当前全部任务
${taskTable(run)}

接下来编排台会把队员的交付、失败和提问发给你处理，届时按每条消息里的格式回复。现在只需要用两三句话确认接手，并说说你对当前进度的理解，这次不要输出 JSON。`;
}

export function fixJson(err) {
  return `你上一条回复没法解析（${err}）。请严格按要求重新输出，只给一个 \`\`\`json 代码块。`;
}

export { STATUS };
