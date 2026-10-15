import { z } from "zod";
import { normalizeOfficialGlmModelId } from "./official-glm-model-id.js";

// 与官方 billing/balance 对齐；容许服务端附加字段，跨进程投影则使用严格 schema。
const time = z.union([z.number(), z.string()]).nullish();
const planSchema = z.object({
  user_plan_id: z.string().optional(),
  plan_id: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  starts_at: time,
  ends_at: time,
  entitlements: z
    .array(
      z.object({
        entitlement_id: z.string().nullish(),
        show_name: z.string().nullish(),
        period: z.string().nullish(),
        effective_at: time,
      }),
    )
    .optional(),
});
const balanceSchema = z.object({
  bucket_id: z.string().optional(),
  user_plan_id: z.string().optional(),
  plan_id: z.string().optional(),
  entitlement_id: z.string().optional(),
  show_name: z.string().optional(),
  meter: z.string().optional(),
  unit_type: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  total_units: time,
  used_units: time,
  reserved_units: time,
  remaining_units: time,
  available_units: time,
  period_start: time,
  period_end: time,
  expires_at: time,
});
export const startPlanBalanceEnvelopeSchema = z.object({
  code: z.number().optional(),
  success: z.boolean().optional(),
  msg: z.string().optional(),
  data: z
    .object({
      server_time: z.number().optional(),
      plans: z.array(planSchema).optional(),
      balances: z.array(balanceSchema).optional(),
    })
    .optional(),
});
export type ZaiStartPlanPlan = z.infer<typeof planSchema>;
export type ZaiStartPlanBalanceEnvelope = z.infer<typeof startPlanBalanceEnvelopeSchema>;

export const startPlanStatusSchema = z
  .object({
    providerId: z.string(),
    label: z.string(),
    status: z.enum([
      "available",
      "pending",
      "unavailable",
      "not-authenticated",
      "verification-required",
      "error",
    ]),
    effectiveAt: z.number().optional(),
    message: z.string().optional(),
    models: z.array(z.string()),
    plans: z.array(
      z
        .object({
          name: z.string(),
          status: z.string(),
          startsAt: z.number().optional(),
          endsAt: z.number().optional(),
          effectiveAt: z.number().optional(),
        })
        .strict(),
    ),
    balances: z.array(
      z
        .object({
          name: z.string(),
          unit: z.string(),
          total: z.number().optional(),
          used: z.number().optional(),
          available: z.number().optional(),
          endsAt: z.number().optional(),
          models: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();
export type StartPlanStatus = z.infer<typeof startPlanStatusSchema>;
export const startPlanReadParamsSchema = z
  .object({ sessionId: z.string().min(1).optional() })
  .strict();

function numeric(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

/** 与 Desktop 共用：HTTP Date 优先，避免 JSON 旧时间复活已过期实例。 */
export function normalizeStartPlanExpiry(
  payload: ZaiStartPlanBalanceEnvelope,
  responseTime?: number,
): ZaiStartPlanBalanceEnvelope {
  if (!payload.data) return payload;
  const now = responseTime ?? numeric(payload.data.server_time) ?? Date.now() / 1000;
  const plans = (payload.data.plans ?? []).map((plan) => {
    const end = numeric(plan.ends_at);
    return plan.status?.trim().toLowerCase() === "active" &&
      end !== undefined &&
      end > 0 &&
      end <= now
      ? { ...plan, status: "expired" }
      : plan;
  });
  const balances = payload.data.balances?.filter((balance) => {
    const owners = plans.filter((plan) =>
      balance.user_plan_id && plan.user_plan_id
        ? plan.user_plan_id === balance.user_plan_id
        : Boolean(plan.plan_id) && plan.plan_id === balance.plan_id,
    );
    return !owners.length || owners.some((plan) => plan.status?.trim().toLowerCase() !== "expired");
  });
  return { ...payload, data: { ...payload.data, server_time: now, plans, balances } };
}

export function resolveZaiStartPlanBalanceModelIds(payload: ZaiStartPlanBalanceEnvelope): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const balance of payload.data?.balances ?? []) {
    const capabilities = (balance.capabilities ?? []).flatMap((capability) => {
      const text = capability.trim();
      return text.toLowerCase().startsWith("model:") ? [text.slice(6).trim()].filter(Boolean) : [];
    });
    for (const candidate of capabilities.length ? capabilities : [balance.show_name ?? ""]) {
      const id = normalizeOfficialGlmModelId(candidate.trim());
      if (!id || seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      result.push(id);
    }
  }
  return result;
}

/** 套餐端点为权威来源，Build 名称无需包含 Start Plan。 */
export function projectStartPlanBalance(
  input: ZaiStartPlanBalanceEnvelope,
  responseTime?: number,
): Omit<StartPlanStatus, "providerId" | "label"> {
  const payload = normalizeStartPlanExpiry(input, responseTime);
  const now = payload.data?.server_time ?? Date.now() / 1000;
  const rawPlans = payload.data?.plans ?? [];
  const plans = rawPlans.map((plan) => {
    const effective = (
      plan.entitlements?.length
        ? plan.entitlements.map((entry) => entry.effective_at)
        : [plan.starts_at]
    )
      .map(numeric)
      .filter((value): value is number => value !== undefined && value > 0);
    return {
      name: plan.name ?? "Start Plan",
      status: plan.status ?? "unknown",
      startsAt: numeric(plan.starts_at),
      endsAt: numeric(plan.ends_at),
      effectiveAt: effective.length ? Math.min(...effective) : undefined,
    };
  });
  if (
    payload.success === false ||
    (payload.code !== undefined && payload.code !== 0 && payload.code !== 200)
  )
    return {
      status: "error",
      message: "Start Plan 权益查询失败，请刷新或重新登录。",
      models: [],
      plans,
      balances: [],
    };
  const active = rawPlans.filter((plan) => plan.status?.trim().toLowerCase() === "active");
  const current = (payload.data?.balances ?? []).filter((balance) => {
    const owners = active.filter((plan) => {
      const owns = balance.user_plan_id
        ? plan.user_plan_id === balance.user_plan_id
        : Boolean(balance.plan_id) && plan.plan_id === balance.plan_id;
      const startsAt = numeric(plan.starts_at);
      const entitlements = balance.entitlement_id
        ? plan.entitlements?.filter((entry) => entry.entitlement_id === balance.entitlement_id)
        : plan.entitlements;
      const effective =
        !plan.entitlements?.length ||
        Boolean(
          entitlements?.some((entry) => {
            const at = numeric(entry.effective_at);
            return at === undefined || at <= now;
          }),
        );
      return owns && effective && (startsAt === undefined || startsAt <= now);
    });
    const end = numeric(balance.expires_at) ?? numeric(balance.period_end);
    const start = numeric(balance.period_start);
    return (
      owners.length > 0 && (end === undefined || end > now) && (start === undefined || start <= now)
    );
  });
  const usable = current.filter((balance) => {
    const remaining = numeric(balance.available_units) ?? numeric(balance.remaining_units);
    return remaining === undefined || remaining > 0;
  });
  const models = resolveZaiStartPlanBalanceModelIds({ data: { balances: usable } });
  const balances = current.map((balance) => ({
    name: balance.show_name ?? "Start Plan",
    unit: balance.unit_type ?? "units",
    total: numeric(balance.total_units),
    used: numeric(balance.used_units),
    available: numeric(balance.available_units) ?? numeric(balance.remaining_units),
    endsAt: numeric(balance.expires_at) ?? numeric(balance.period_end),
    models: resolveZaiStartPlanBalanceModelIds({ data: { balances: [balance] } }),
  }));
  const effectiveTimes = active.flatMap((plan) =>
    plan.entitlements?.length
      ? plan.entitlements.map((entry) => numeric(entry.effective_at))
      : [numeric(plan.starts_at)],
  );
  const pending =
    !models.length &&
    effectiveTimes.length > 0 &&
    effectiveTimes.every((value) => value !== undefined && value > now);
  return {
    status: models.length ? "available" : pending ? "pending" : "unavailable",
    models,
    plans,
    balances,
    ...(pending
      ? {
          effectiveAt: Math.min(
            ...effectiveTimes.filter((value): value is number => value !== undefined),
          ),
        }
      : {}),
  };
}
