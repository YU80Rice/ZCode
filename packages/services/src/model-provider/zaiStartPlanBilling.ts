import type { ApiClient } from "@zcode/shared";
import {
  buildRuntimeZCodeEndpointUrls,
  normalizeStartPlanExpiry,
  ZCODE_VERSION,
} from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";

const REQUEST_TIMEOUT_MS = 15_000;
const ZAI_START_PLAN_BALANCE_URL = buildRuntimeZCodeEndpointUrls(
  process.env,
).zcodePlanBillingBalanceUrl;

export type { ZaiStartPlanPlan, ZaiStartPlanBalanceEnvelope } from "@zcode/shared";
import type { ZaiStartPlanBalanceEnvelope } from "@zcode/shared";
export { resolveZaiStartPlanBalanceModelIds } from "@zcode/shared";

const inflightBalanceRequests = new WeakMap<
  ApiClient,
  Map<string, Promise<ZaiStartPlanBalanceEnvelope>>
>();

export function buildZaiStartPlanBalanceUrl(): string {
  const url = new URL(ZAI_START_PLAN_BALANCE_URL);
  // Start Plan balance 接口按真实 app_version 判定能力；
  // 开发环境也不能固定 3.0.0，否则本地验证会绕过当前 App 版本的后端策略。
  url.searchParams.set("app_version", ZCODE_VERSION);
  return url.toString();
}

export async function fetchZaiStartPlanBalanceEnvelope(
  apiClient: ApiClient,
  authorization: string,
  invalidateCache = false,
): Promise<ZaiStartPlanBalanceEnvelope> {
  const requestKey = JSON.stringify({
    authorization: authorization.trim(),
    url: buildZaiStartPlanBalanceUrl(),
  });

  let requests = inflightBalanceRequests.get(apiClient);
  if (!requests) {
    requests = new Map();
    inflightBalanceRequests.set(apiClient, requests);
  }

  if (invalidateCache) requests.delete(requestKey);
  const inflight = requests.get(requestKey);
  if (inflight) {
    return inflight;
  }

  const url = buildZaiStartPlanBalanceUrl();
  const startedAt = Date.now();
  let responseTime: number | undefined;
  const observedApi: ApiClient = {
    request: async (input, init) => {
      const response = await apiClient.request(input, init);
      const date = Date.parse(response.headers.get("date") ?? "");
      if (Number.isFinite(date)) responseTime = date / 1000;
      return response;
    },
  };
  const request = readApiJson<ZaiStartPlanBalanceEnvelope>(observedApi, url, {
    method: "GET",
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: authorization,
    },
  })
    .then((payload) => normalizeStartPlanExpiry(payload, responseTime))
    .finally(() => {
      // 账号校验先完成，用量查询随后到达：保留同一响应至发起后 1 秒。
      // 失败同样保留，避免 429 之后立刻重复请求；旧请求不得删除失效后创建的新记录。
      const evict = () => {
        if (requests?.get(requestKey) !== request) return;
        requests.delete(requestKey);
        if (requests.size === 0) inflightBalanceRequests.delete(apiClient);
      };
      const remainingMs = 1000 - (Date.now() - startedAt);
      if (remainingMs > 0) setTimeout(evict, remainingMs);
      else evict();
    });

  requests.set(requestKey, request);
  return request;
}
