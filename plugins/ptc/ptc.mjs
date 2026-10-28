const buildPtcPrompt = task => `对以下任务采用 PTC（Programmatic Tool Calling）工作流：

${task}

## 工具调用

1. 对能通过 session 工具完成的操作，MUST 优先调用 \`eval\`，并在 JavaScript 或 Python runtime 中以 \`await tool.<name>(args)\` 调用工具。
2. 将相关的读取、查询、循环、分支、结果处理集中在一个或少量 eval cell 中完成；独立操作可在同一个 JavaScript cell 中用 \`Promise.all\` 并发。
3. 只输出后续决策需要的结果，避免将中间数据逐步交回模型再决定下一次工具调用。
4. 仅在 eval 不可用、目标能力未暴露给 eval，或工具审批、交互机制要求直接调用时，才直接调用工具。
5. 不得为了形式而将单一步骤无意义地包进 eval；目标是让程序负责工具编排并减少模型—工具往返。

## 约束

遵守当前任务的其他指令、工具启用状态与审批门控。此 command 是工作流指令，不改变 OMP 向模型提供的工具集合。`;

export default function (pi) {
  pi.registerCommand("ptc", {
    description: "以 eval 编排工具调用执行任务",
    handler: async args => {
      pi.sendUserMessage(buildPtcPrompt(args));
    },
  });
}
