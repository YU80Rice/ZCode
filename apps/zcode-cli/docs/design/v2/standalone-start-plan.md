# 独立 CLI 的 Start Plan

## 目标与责任

独立 `app-server --stdio --standalone` 使用本 profile 的 OAuth 登录与 Zcode JWT 查询官方 Start Plan 权益；VelaTerm 通过原生协议展示套餐、待生效时间、模型和原始单位额度。不能要求先发送消息，不能启动或依赖 Zcode GUI，不能将 JWT、账户标识或 API Key 传给 VelaTerm。

- Shared 的纯函数负责 billing/balance 响应的时间、模型白名单、套餐和额度投影；Desktop 与 CLI 共用已有余额契约。
- Bootstrap 的独立 Start Plan 运行时负责当前凭据、请求准入、账号代际和 HTTP 端口调用。账号 Overlay 仍由现有 AccountProviderService 串行发布。
- Adapter 提供 HTTP 与持久设备标识。使用真实构建版本、CLI 来源、既有代理/证书配置与官方 endpoint，不冒充 Desktop，不生成验证凭证。
- VelaTerm 仅展示无秘密的 `provider/readStartPlan` 返回值。每个查询使用会话环境，冷查询不创建持久原生会话，不改变账号或历史目录。

## 顺序与失效

```text
读取 Built-in + 当前 active_provider/JWT
  → billing/balance（Bearer JWT + 真实设备标识）
  → 重读凭据；发生账号切换则丢弃迟到结果
  → 纯函数投影 → AccountProviderService 发布 Overlay → Registry 模型目录
模型请求 → 重查当前权益和白名单 → 校验原账号代际 → 交付 JWT → 原生模型端点
VelaTerm 打开模型菜单 → provider/readStartPlan → 套餐/时间/额度投影
```

CLI 只认与 `oauth:active_provider` 相符的 Start Plan Provider。个人 Coding Plan 的 PAT 与手工 Key 不参与此路径。模型由有效额度桶返回，显式空列表清空旧白名单；不从个人 Coding Plan、API 余额或其他提供商推测模型。失效、额度不足、401/403、验证要求或网络错误均不得回退到其他收费通道。请求前重查权益；取消与账号切换后不得交付旧 JWT。读查询幂等，无模型生成、无余额写入。

HTTP Date 优先于 JSON server_time，本地时间仅作缺省。展示所有套餐实例；Global Build、Weekend Build 属于此端点的套餐，不能因名称不含 Start Plan 而漏掉。待生效必须有明确的未来 effective_at；过期套餐/额度桶不能提供模型。额度使用服务器原始单位，不能自行当成 Token 或金额。空余额表示无可用模型，不伪造额度。生效后通过刷新重新查询，不承诺在关闭应用时后台自动激活。

协议返回版本化结构 `{ plans: [...] }`，状态为 available/pending/unavailable/not-authenticated/verification-required/error，含 providerId、label、effectiveAt、套餐时间及逐桶额度。失败消息采用固定无秘密文案。公开版不具备官方交互验证实现时，明确说明需官方支持，禁止声称已通过验证。

## 显式登录入口

`zcode login <bigmodel|zai> start-plan` 明确请求账户套餐登录，完成官方 OAuth 后保存 JWT，不兑换 PAT，不要求购买个人 Coding Plan，不改写默认模型。成功回包的 model 为空字符串，表示等待用户从权益目录选择。旧的 `login <family>` 保持个人 Coding Plan 行为。VelaTerm 账户菜单分别提供 Start Plan 与个人 Coding Plan；登录 Start Plan 前清除本家族旧 OAuth 连接身份，避免新账户的 OAuth 搭配旧项目身份，手工 Key 保留。清除发生在授权成功之后、保存新凭据之前；失败时不得继续发送旧账户身份。

## 验收接缝

Start Plan 的模型请求与账单查询遵循同一个 `ZCODE_ENDPOINT_ORIGIN`。静态路由仅将官方 `https://zcode.z.ai/api/v1/zcode-plan/` 路径重定向到配置 origin，保留路径与查询参数；第三方地址、其他端口与相似主机不改写。该规则确保隔离测试中的模型请求不会逃逸到官方服务，也确保自定义部署的账单与模型服务一致。

1. Shared 余额投影：官方真实待生效响应、活动/过期/空额度、独立套餐实例与模型能力。
2. 独立运行时公开接口：JWT 和设备头、无 PAT 回退、账号切换、取消、HTTP/业务错误、模型白名单及余额投影。
3. 最终 EXE 的原生创建会话/模型菜单/选择/发起回合；本地官方端点夹具记录 JWT 通道和额度变化，隔离个人账号。
4. 实际账号只读权益查询；仅在套餐生效且官方允许时做最小真实回合，分别报告夹具证据与线上证据。

本规格的测试接缝按用户“构建和测试你自己跑”的授权执行，无需再次确认。Windows 成品仍为 0.2.9 独立候选，不覆盖稳定版本；PR 对接官方更新分支。
