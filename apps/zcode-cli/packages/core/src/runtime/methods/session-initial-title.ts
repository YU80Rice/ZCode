import { SessionEventType, type TraceContext } from "../deps.js";
import { titleFromInput } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";

/** 空会话先落盘时没有首输入；同一持久化 owner 在真实输入到达后交接标题。 */
export async function promoteInitialSessionTitle(
  runtime: AgentRuntimeInternal,
  input: string,
  traceContext: TraceContext,
): Promise<void> {
  if (!input.trim() || !runtime.sessionStore) return;
  const session = await runtime.sessionStore.getSession(runtime.sessionId);
  if (session?.titleSource !== "default") return;
  const title = titleFromInput(input);
  const updated = await runtime.sessionStore.updateSession({
    id: runtime.sessionId,
    expectedTitleSources: ["default"],
    title,
    titleSource: "first_input",
  });
  // CAS 保护用户命名与已有标题；不把失败的交接作为标题更新广播。
  if (updated.titleSource !== "first_input" || updated.title !== title) return;
  await runtime.appendEvent(
    runtime.createEvent(
      SessionEventType.SessionTitleUpdated,
      { previousTitle: session.title, source: "first_input", title },
      traceContext,
    ),
    traceContext,
  );
}
