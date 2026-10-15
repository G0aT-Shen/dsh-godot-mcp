// 把规范工具定义适配成 DSH 的 ToolDefinition 并注册。
//
// DSH 的 tools.register() 契约（来自 cordis_inspect host/Service）：
//   { name, description, parameters, output: { schema, render }, execute(args, exec) }
// 注意与 MCP 的差别：DSH 用 `parameters`（裸 JSON Schema），MCP 用 `inputSchema`；
// DSH 必须有 `output.schema` + `output.render`。

/**
 * 把任意值渲染成给模型看的 ContentBlock[]。
 * @param {unknown} value
 * @returns {Array<{type: string, text: string}>}
 */
export function renderValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return [{ type: 'text', text: text ?? '(空)' }];
}

/** 宽松输出 schema：工具结果形状随 op 变化，用 object 允许任意键。 */
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true, properties: {} };

/**
 * 注册全部 Godot 工具到 DSH 工具注册表。
 * @param {import('./server.mjs').GodotController} controller
 * @param {{register: (definition: object) => (() => void)}} toolsService 通常是 ctx.get('tools')
 * @param {{logger?: {info?: Function, warn?: Function, error?: Function}, onRegister?: Function}} [options]
 * @returns {() => void} 一次性注销全部工具
 */
export function registerGodotTools(controller, toolsService, options = {}) {
  const log = options.logger ?? {};
  const definitions = options.definitions ?? [];
  const disposers = [];

  for (const tool of definitions) {
    const definition = {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
      execute: async (args, exec) => {
        try {
          return await tool.handler(args ?? {}, exec);
        } catch (error) {
          // 工具本身抛错会让调用以异常结束；这里统一转成结构化失败，
          // 保证模型能看到 code + message 而不是一段堆栈。
          log.warn?.(`godot-mcp: 工具 ${tool.name} 执行失败：${String(error?.message ?? error)}`);
          return {
            ok: false,
            tool: tool.name,
            code: error?.code ?? 'TOOL_EXCEPTION',
            error: String(error?.message ?? error),
          };
        }
      },
    };
    try {
      const dispose = toolsService.register(definition);
      disposers.push(dispose);
      options.onRegister?.(tool.name);
    } catch (error) {
      // 单个工具注册失败不能拖垮整个插件（DSH 会回滚整个插件条目）。
      log.error?.(`godot-mcp: 注册工具 ${tool.name} 失败：${String(error?.message ?? error)}`);
    }
  }

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* 已被上层清理 */
      }
    }
  };
}
