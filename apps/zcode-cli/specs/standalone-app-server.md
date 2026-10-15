# 独立 app-server 账户运行时

第三方终端宿主可显式启动 `zcode app-server --stdio --standalone`。现有 Desktop Host 不传此参数，行为保持原样。

CLI 入口把独立模式传入 bootstrap 公共 RunZCodeProtocolAgentOptions。bootstrap 复用 startProcessProviderRegistryRuntime 的 standalone 选项以及 providerRuntimeHeadersPort，不新增账户服务、不请求 Host 注入凭据。不接收 Host 的账户配置覆盖，凭据及刷新始终由 CLI 原有 credential store 拥有。每个会话及子任务使用同一进程账户运行时，模型选择与会话历史保持原有隔离规则。

事件顺序、NDJSON schema、退出取消与资源释放维持现有协议；第三方宿主响应运行偏好和权限交互。独立运行失败明确返回错误，不降级依赖 GUI。新增参数默认 false，兼容 app-server 和 agent-server。

验收：参数解析、新建独立会话、原生模型列表与登录、不存在 requestProviderRuntimeHeaders 的 Host 依赖、Desktop 默认回归。
