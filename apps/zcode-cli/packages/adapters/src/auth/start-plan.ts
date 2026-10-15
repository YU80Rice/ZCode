import type { HttpClientPort, TraceContext } from "@zcode/contracts";
import {
  buildRuntimeZCodeEndpointUrls,
  buildZCodeSourceHeadersFromContext,
  projectStartPlanBalance,
  startPlanBalanceEnvelopeSchema,
  ZCODE_VERSION,
  type StartPlanStatus,
} from "@zcode/shared";
import { ensureCliDeviceMid } from "../device/cli-device-mid.js";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
export interface StartPlanBalanceClient {
  read(
    jwt: string,
    signal?: AbortSignal,
    trace?: TraceContext,
  ): Promise<Omit<StartPlanStatus, "providerId" | "label">>;
}

/** 原生 CLI 的真实来源、设备标识、代理及 TLS 均走已有端口。 */
export function createStartPlanBalanceClient(options: {
  httpClient: HttpClientPort;
  env: Record<string, string | undefined>;
}): StartPlanBalanceClient {
  return {
    async read(jwt, signal, trace) {
      signal?.throwIfAborted();
      const urls = buildRuntimeZCodeEndpointUrls(options.env);
      const url = new URL(urls.zcodePlanBillingBalanceUrl);
      url.searchParams.set("app_version", ZCODE_VERSION);
      const headers = buildZCodeSourceHeadersFromContext({
        appVersion: ZCODE_VERSION,
        arch: process.arch,
        platform: process.platform,
        endpointOrigin: urls.origin,
        sourceTitle: "cli",
        deviceMid: await ensureCliDeviceMid({ env: options.env }),
      });
      const response = await options.httpClient.request(
        {
          url: url.toString(),
          method: "GET",
          trace,
          headers: { ...headers, Authorization: `Bearer ${jwt}` },
          timeoutMs: TIMEOUT_MS,
          maxResponseBytes: MAX_RESPONSE_BYTES,
        },
        { signal },
      );
      signal?.throwIfAborted();
      const empty = { models: [], plans: [], balances: [] };
      if (response.status === 401)
        return {
          ...empty,
          status: "not-authenticated",
          message: "Start Plan 登录已失效，请重新登录 Zcode。",
        };
      if (response.status === 403)
        return {
          ...empty,
          status: "verification-required",
          message:
            "官方接口拒绝请求或要求额外验证；当前独立 CLI 无法完成官方交互验证，请使用官方支持的登录流程后重试。",
        };
      if (response.status < 200 || response.status >= 300)
        return { ...empty, status: "error", message: "Start Plan 权益查询失败，请稍后刷新。" };
      const payload = startPlanBalanceEnvelopeSchema.safeParse(
        JSON.parse(new TextDecoder().decode(response.body)),
      );
      if (!payload.success)
        return { ...empty, status: "error", message: "Start Plan 权益响应不兼容，请更新 CLI。" };
      const date = Date.parse(response.headers.date ?? response.headers.Date ?? "");
      return projectStartPlanBalance(payload.data, Number.isFinite(date) ? date / 1000 : undefined);
    },
  };
}
