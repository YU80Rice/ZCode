import { describe, expect, it, vi } from "vitest";
import { ProviderConfig, ProviderConfigMap, ZhipuAccountAccessConfig } from "@zcode/provider";
import type { StartPlanBalanceClient } from "@zcode/adapters/auth";
import { createStandaloneStartPlanRuntime } from "../src/app/standalone-start-plan-runtime.js";
import { createStandaloneProviderRuntimeHeadersPort } from "../src/app/standalone-account-provider-runtime.js";

const providerId = "account:bigmodel-start-plan";
const providers = new ProviderConfigMap([
  [
    providerId,
    new ProviderConfig({
      access: new ZhipuAccountAccessConfig({ accountType: "bigmodel", mode: "start-plan" }),
      builtinModelIds: ["obsolete"],
    }),
  ],
]);
function fixture() {
  const values = new Map([
    ["oauth:active_provider", "bigmodel"],
    ["zcodejwttoken", "fixture-jwt"],
  ]);
  const store = {
    loadMany: async (keys: readonly string[]) =>
      Object.fromEntries(keys.map((key) => [key, values.get(key) ?? null])),
  };
  const client = {
    read: vi.fn<StartPlanBalanceClient["read"]>(async () => ({
      status: "available" as const,
      models: ["GLM-5.3"],
      plans: [],
      balances: [
        {
          name: "GLM-5.3",
          unit: "credits",
          total: 100,
          used: 20,
          available: 80,
          models: ["GLM-5.3"],
        },
      ],
    })),
  };
  const runtime = createStandaloneStartPlanRuntime(store, {}, client);
  const request = {
    providerId,
    modelId: "GLM-5.3",
    accountAccess: {
      type: "zhipu-account" as const,
      accountType: "bigmodel" as const,
      mode: "start-plan" as const,
      entitled: true,
    },
    reason: "model-request" as const,
    sessionId: "test" as never,
    traceContext: { traceId: "test" } as never,
  };
  return { values, store, client, runtime, request };
}
describe("独立 Start Plan", () => {
  it("按官方白名单发布独立 Provider，发送 JWT 并保持额度来源", async () => {
    const f = fixture();
    const result = await f.runtime.read(providers);
    expect(result.providers.get(providerId)?.access).toMatchObject({ entitled: true });
    expect(result.providers.get(providerId)?.builtinModelIds).toEqual(["GLM-5.3"]);
    expect(result.plans[0]).toMatchObject({
      providerId,
      status: "available",
      balances: [{ available: 80 }],
    });
    expect(JSON.stringify(result.plans)).not.toContain("fixture-jwt");
    await expect(f.runtime.requestAuth(f.request)).resolves.toMatchObject({
      requestAuth: { apiKey: "fixture-jwt" },
    });
    expect(f.client.read).toHaveBeenLastCalledWith(
      "fixture-jwt",
      undefined,
      f.request.traceContext,
    );
  });
  it("现有原生请求端口必须真正路由 Start Plan，禁止兑换个人 Coding Plan Token", async () => {
    const f = fixture();
    const resolver = { resolve: vi.fn(), resolveMaterial: vi.fn(), clear: vi.fn() };
    const store = {
      ...f.store,
      load: async (key: string) => f.values.get(key) ?? null,
      save: vi.fn(),
      delete: vi.fn(),
    };
    const port = createStandaloneProviderRuntimeHeadersPort(store, {}, resolver, f.runtime);
    await expect(port.refreshBeforeModelRequest(f.request)).resolves.toMatchObject({
      requestAuth: { apiKey: "fixture-jwt" },
    });
    expect(resolver.resolveMaterial).not.toHaveBeenCalled();
  });
  it.each([
    "pending",
    "unavailable",
    "not-authenticated",
    "verification-required",
    "error",
  ] as const)("%s 时拒绝发送，清空旧白名单", async (status) => {
    const f = fixture();
    f.client.read.mockResolvedValue({ status, models: [], plans: [], balances: [] });
    expect((await f.runtime.read(providers)).providers.get(providerId)?.builtinModelIds).toEqual(
      [],
    );
    await expect(f.runtime.requestAuth(f.request)).rejects.toThrow();
  });
  it("其他账户家族与缺失 JWT 都不读取额度或借用登录材料", async () => {
    const f = fixture();
    f.values.set("oauth:active_provider", "zai");
    expect((await f.runtime.read(providers)).plans[0].status).toBe("not-authenticated");
    f.values.delete("zcodejwttoken");
    await expect(f.runtime.requestAuth(f.request)).rejects.toThrow();
    expect(f.client.read).not.toHaveBeenCalled();
  });
  it("所选模型不在当前白名单时不发送 JWT", async () => {
    const f = fixture();
    await expect(f.runtime.requestAuth({ ...f.request, modelId: "not-in-plan" })).rejects.toThrow(
      "不包含",
    );
  });
  it("查询中切换账户会废弃迟到权益", async () => {
    const f = fixture();
    f.client.read.mockImplementation(async () => {
      f.values.set("zcodejwttoken", "another-account");
      return { status: "available", models: ["GLM-5.3"], plans: [], balances: [] };
    });
    await expect(f.runtime.requestAuth(f.request)).rejects.toThrow("scope_invalidated");
  });
  it("取消与旧账号恢复标识均不能交付请求身份", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(
      f.runtime.requestAuth({ ...f.request, abortSignal: abort.signal }),
    ).rejects.toThrow();
    expect(f.client.read).not.toHaveBeenCalled();
    await expect(
      f.runtime.requestAuth({ ...f.request, expectedAccountScope: "old-account" }),
    ).rejects.toThrow("scope_invalidated");
  });
});
