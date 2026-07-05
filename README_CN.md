# GSC MCP 服务器

Google Search Console MCP Server — 一个 TypeScript 实现的 [Model Context Protocol](https://modelcontextprotocol.io) 服务器，为 Claude Desktop 等 AI 助手提供与 Google Search Console API 交互的工具。

本项目是 [mcp-gsc](https://github.com/aminforoutan/mcp-gsc) Python 服务器的 TypeScript 移植版，完全兼容 MCP 规范。

## 功能特性

- **21 个 MCP 工具**，覆盖 Google Search Console 全部操作
- **双重认证** — OAuth 2.0（浏览器登录）和服务账号
- **跨平台** — Windows、macOS、Linux
- **STDIO 和 SSE 传输**支持
- **零配置回退** — 所有设置均有合理默认值
- **安全优先** — 危险操作默认禁用

## 工具概览

| 分类 | 工具名称 | 说明 |
|------|----------|------|
| **认证** | `reauthenticate` | 注销并使用其他 Google 账户重新登录 |
| **资产** | `list_properties` | 列出您可访问的所有 GSC 站点 |
| | `get_site_details` | 获取站点的验证和所有权信息 |
| | `add_site` | 添加新资产 *（危险操作 — 默认禁用）* |
| | `delete_site` | 删除资产 *（危险操作 — 默认禁用）* |
| **数据分析** | `get_search_analytics` | 热门查询/页面，含点击、展示、CTR、排名 |
| | `get_performance_overview` | 某时间段的性能摘要及每日趋势 |
| | `compare_search_periods` | 比较两个时间段的性能差异 |
| | `get_search_by_page_query` | 驱动特定页面流量的搜索查询 |
| | `get_advanced_search_analytics` | 高级过滤、排序和分页 |
| **URL 检查** | `inspect_url_enhanced` | 查看 URL 的详细抓取/索引/富媒体状态 |
| | `batch_url_inspection` | 批量检查最多 10 个 URL |
| | `check_indexing_issues` | 检查多个 URL 的索引问题 |
| **站点地图** | `get_sitemaps` | 列出站点的所有站点地图 |
| | `list_sitemaps_enhanced` | 站点地图详细信息（含错误和警告） |
| | `get_sitemap_details` | 特定站点地图的详细信息 |
| | `submit_sitemap` | 提交或重新提交站点地图 |
| | `delete_sitemap` | 删除站点地图 *（危险操作 — 默认禁用）* |
| | `manage_sitemaps` | 一体化操作：列表、详情、提交、删除 |
| **信息** | `get_capabilities` | 列出所有工具、认证状态和入门指南 |

## 环境要求

- **Node.js** 18+（推荐 LTS 版本）
- 已启用 **Search Console API** 的 Google Cloud 项目
- 至少配置一种认证方式（见下文）

## 安装

```bash
# 克隆仓库
git clone <repo-url> gsc-mcp
cd gsc-mcp

# 安装依赖
npm install

# 编译
npm run build
```

## 认证配置

需要配置以下两种认证方式之一：

### 方式一：OAuth 2.0（推荐）

适合个人用户使用。会打开浏览器窗口进行 Google 登录。

1. 在 [console.cloud.google.com](https://console.cloud.google.com) 创建 Google Cloud 项目
2. 启用 **Google Search Console API**
3. 创建 **OAuth 2.0 客户端 ID** 凭据（桌面应用类型）
4. 下载客户端密钥 JSON 文件

设置环境变量：

```bash
# Windows (PowerShell)
$env:GSC_OAUTH_CLIENT_SECRETS_FILE = "C:\path\to\client_secrets.json"

# macOS / Linux
export GSC_OAUTH_CLIENT_SECRETS_FILE="/path/to/client_secrets.json"
```

或将文件命名为 `client_secrets.json` 放在项目源码目录下。

首次使用时，服务器会自动打开浏览器进行认证，无需手动管理 token。

### 方式二：服务账号

适合服务器/自动化场景。

1. 在 Google Cloud 项目中创建服务账号
2. 下载 JSON 密钥文件
3. 将服务账号邮箱作为用户添加到每个 GSC 资产中

```bash
# Windows (PowerShell)
$env:GSC_CREDENTIALS_PATH = "C:\path\to\service_account_credentials.json"

# macOS / Linux
export GSC_CREDENTIALS_PATH="/path/to/service_account_credentials.json"
```

## Claude Desktop 配置

编辑 `claude_desktop_config.json`：

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "gsc": {
      "command": "node",
      "args": [
        "C:\\path\\to\\gsc-mcp\\build\\index.js"
      ],
      "env": {
        "GSC_OAUTH_CLIENT_SECRETS_FILE": "C:\\path\\to\\client_secrets.json"
      }
    }
  }
}
```

macOS/Linux 用户请使用正斜杠路径，并将环境变量配置为 `export` 格式。

保存后重启 Claude Desktop。输入框中应出现锤子图标。

## 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `GSC_OAUTH_CLIENT_SECRETS_FILE` | （无） | OAuth 客户端密钥 JSON 文件的绝对路径 |
| `GSC_CREDENTIALS_PATH` | （无） | 服务账号凭据 JSON 文件的绝对路径 |
| `GSC_SKIP_OAUTH` | `false` | 设为 `true` 跳过 OAuth，仅使用服务账号 |
| `GSC_ALLOW_DESTRUCTIVE` | `false` | 设为 `true` 启用添加/删除操作 |
| `GSC_DATA_STATE` | `all` | `all`（与 GSC 控制台一致）或 `final`（仅已确认数据，有 2-3 天延迟） |
| `GSC_CONFIG_DIR` | 平台默认 | 覆盖配置/缓存目录以存放 token 文件 |
| `MCP_TRANSPORT` | `stdio` | `stdio` 或 `sse`（HTTP SSE） |
| `MCP_HOST` | `127.0.0.1` | SSE 传输时绑定的主机地址 |
| `MCP_PORT` | `3001` | SSE 传输时绑定的端口 |

## 使用 SSE 传输运行

```bash
# Windows (PowerShell)
$env:MCP_TRANSPORT = "sse"
$env:MCP_HOST = "0.0.0.0"
$env:MCP_PORT = "3001"
npm run start

# macOS / Linux
MCP_TRANSPORT=sse MCP_HOST=0.0.0.0 MCP_PORT=3001 npm run start
```

## 开发指南

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 运行（stdio 模式）
npm run start
```

## 项目结构

```
gsc-mcp/
├── src/
│   ├── index.ts    # MCP 服务器入口 + 全部 21 个工具注册
│   └── auth.ts     # Google 认证（OAuth 2.0 + 服务账号）
├── build/          # 编译后的 JavaScript 输出
├── package.json
└── tsconfig.json
```

## 致谢

原始 Python 版 MCP-GSC 服务器由 [Amin Foroutan](https://aminforoutan.com/) 创建。

## 许可证

ISC
