import { createHash } from "node:crypto";
import {
  createStartPlanBalanceClient,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type SharedZCodeCredentialStore,
  type StartPlanBalanceClient,
} from "@zcode/adapters/auth";
import { createNodeHttpClientAdapter } from "@zcode/adapters/http";
import { createConfig } from "@zcode/adapters/config";
import type { ProviderRuntimeHeadersPort } from "@zcode/core";
import {
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  type AccountProviderStates,
} from "@zcode/provider";
import type { StartPlanStatus } from "@zcode/shared";
import type { TraceContext } from "@zcode/contracts";

type Request = Parameters<ProviderRuntimeHeadersPort["refreshBeforeModelRequest"]>[0];
const JWT_KEY = SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken;
const FAMILY_KEY = SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider;
type Identity = { family: string; jwt: string };

export function createStandaloneStartPlanRuntime(
  store: Pick<SharedZCodeCredentialStore, "loadMany">,
  env: Readonly<Record<string, string | undefined>>,
  injectedClient?: StartPlanBalanceClient,
) {
  const network = createConfig({ env }).config.network;
  const client =
    injectedClient ??
    createStartPlanBalanceClient({
      env: { ...env },
      httpClient: createNodeHttpClientAdapter({
        env: { ...env },
        proxyUrl: network.httpProxy,
        noProxy: network.noProxy,
        caCertFile: network.caCertFile,
        timeoutMs: network.timeout,
      }),
    });
  let projection: readonly StartPlanStatus[] = [];
  async function identity(): Promise<Identity> {
    const values = await store.loadMany([FAMILY_KEY, JWT_KEY]);
    return { family: values[FAMILY_KEY]?.trim() ?? "", jwt: values[JWT_KEY]?.trim() ?? "" };
  }
  function scope(providerId: string, value: Identity): string {
    return createHash("sha256")
      .update(JSON.stringify([providerId, value.family, value.jwt]))
      .digest("hex");
  }
  async function query(
    providerId: string,
    family: string,
    signal?: AbortSignal,
    trace?: TraceContext,
  ) {
    signal?.throwIfAborted();
    const current = await identity();
    const base = {
      providerId,
      label: family === "bigmodel" ? "BigModel · Start Plan" : "Z.AI · Start Plan",
      models: [],
      plans: [],
      balances: [],
    };
    if (!current.jwt || current.family !== family)
      return { status: { ...base, status: "not-authenticated" as const }, current };
    let status: StartPlanStatus;
    try {
      status = { ...base, ...(await client.read(current.jwt, signal, trace)) };
    } catch {
      signal?.throwIfAborted();
      status = { ...base, status: "error", message: "Start Plan 权益查询失败，请检查网络后刷新。" };
    }
    signal?.throwIfAborted();
    const after = await identity();
    if (after.family !== current.family || after.jwt !== current.jwt)
      throw new Error("start_plan_scope_invalidated：账户已切换，请重新查询 Start Plan。");
    return { status, current };
  }
  return {
    getPlans(): StartPlanStatus[] {
      return structuredClone(projection) as StartPlanStatus[];
    },
    async read(configured: ProviderConfigMap) {
      const plans: StartPlanStatus[] = [];
      const entries: [string, ProviderConfig][] = [];
      const states: Record<string, AccountProviderStates[string]> = {};
      for (const [providerId, provider] of configured.entries()) {
        const access = provider.access;
        if (access?.type !== "zhipu-account" || access.mode !== "start-plan" || !access.accountType)
          continue;
        const { status, current } = await query(providerId, access.accountType);
        plans.push(status);
        const entitled = status.status === "available";
        entries.push([
          providerId,
          new ProviderConfig({
            access: new ZhipuAccountAccessConfig({ entitled }),
            builtinModelIds: status.models,
          }),
        ]);
        states[providerId] = {
          availability: entitled
            ? "available"
            : status.status === "pending"
              ? "pending"
              : "unavailable",
          entitled,
          current: current.family === access.accountType,
          ...(status.effectiveAt ? { effectiveAt: status.effectiveAt } : {}),
        };
      }
      projection = structuredClone(plans);
      return { plans, providers: new ProviderConfigMap(entries), states };
    },
    async requestAuth(input: Request) {
      const access = input.accountAccess;
      if (access?.mode !== "start-plan" || !access.accountType)
        throw new Error("start_plan_account_required");
      const { status, current } = await query(
        input.providerId,
        access.accountType,
        input.abortSignal,
        input.traceContext,
      );
      const accountScope = scope(input.providerId, current);
      if (input.expectedAccountScope && input.expectedAccountScope !== accountScope)
        throw new Error("start_plan_scope_invalidated");
      if (status.status !== "available")
        throw new Error(
          status.message ??
            (status.status === "pending"
              ? "Start Plan 权益尚未生效，请在生效后刷新。"
              : "Start Plan 当前没有可用额度或模型，请刷新权益或重新登录。"),
        );
      if (!status.models.some((model) => model.toLowerCase() === input.modelId.toLowerCase()))
        throw new Error("Start Plan 当前额度不包含所选模型，请刷新模型列表。");
      input.abortSignal?.throwIfAborted();
      return { headersApplied: true, requestAuth: { apiKey: current.jwt, accountScope } };
    },
  };
}
