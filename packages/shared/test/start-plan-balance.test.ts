import { describe, expect, it } from "vitest";
import { projectStartPlanBalance } from "../src/start-plan-balance.js";

describe("Start Plan 官方余额投影", () => {
  it("服务端以 0 表示未指定生效日期时，不显示 1970 年日期", () => {
    const status = projectStartPlanBalance({
      data: {
        server_time: 1000,
        plans: [
          { name: "ZCode Global Build", status: "active", entitlements: [{ effective_at: 0 }] },
        ],
      },
    });
    expect(status.plans[0].effectiveAt).toBeUndefined();
  });
  it("展示真实 Global/Weekend Build 的未来权益，不伪造模型或额度", () => {
    const status = projectStartPlanBalance({
      code: 0,
      data: {
        server_time: 1792068502,
        plans: [
          {
            name: "ZCode Weekend Build",
            status: "active",
            ends_at: 1792371600,
            entitlements: [{ effective_at: 1792162800 }],
          },
          {
            name: "ZCode Global Build",
            status: "active",
            ends_at: 1792166399,
            entitlements: [{ effective_at: 1792076400 }],
          },
        ],
        balances: [],
      },
    });
    expect(status).toMatchObject({
      status: "pending",
      effectiveAt: 1792076400,
      models: [],
      balances: [],
    });
    expect(status.plans.map((plan) => plan.name)).toEqual([
      "ZCode Weekend Build",
      "ZCode Global Build",
    ]);
  });
  it("额度耗尽仍显示服务器的 0，但停止提供对应模型", () => {
    const status = projectStartPlanBalance({
      code: 0,
      data: {
        server_time: 1000,
        plans: [{ user_plan_id: "instance", status: "active", ends_at: 2000 }],
        balances: [
          {
            user_plan_id: "instance",
            show_name: "GLM-5.3",
            unit_type: "credits",
            capabilities: ["model:GLM-5.3"],
            total_units: "10",
            used_units: "10",
            available_units: "0",
          },
        ],
      },
    });
    expect(status.status).toBe("unavailable");
    expect(status.models).toEqual([]);
    expect(status.balances).toEqual([
      expect.objectContaining({ available: 0, used: 10, total: 10, unit: "credits" }),
    ]);
  });
  it("未来权益的余额桶不能提前开放模型", () => {
    const result = projectStartPlanBalance({
      data: {
        server_time: 1000,
        plans: [
          {
            user_plan_id: "future",
            status: "active",
            starts_at: 900,
            ends_at: 3000,
            entitlements: [{ entitlement_id: "ent", effective_at: 2000 }],
          },
        ],
        balances: [
          {
            user_plan_id: "future",
            entitlement_id: "ent",
            available_units: 20,
            capabilities: ["model:GLM-5.3"],
          },
        ],
      },
    });
    expect(result.status).toBe("pending");
    expect(result.models).toEqual([]);
  });
});
