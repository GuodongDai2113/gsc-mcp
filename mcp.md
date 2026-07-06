# MCP 配置

## 本地开发版

使用 `npx` 直接运行 TypeScript 源码（无需手动 build）：

```json
{
  "mcpServers": {
    "gsc": {
      "command": "npx",
      "args": [
        "--package",
        "gsc-mcp",
        "gsc-mcp"
      ],
      "env": {
        "GSC_OAUTH_CLIENT_SECRETS_FILE": "C:\\path\\to\\client_secrets.json"
      }
    }
  }
}
```

或用 `tsx` 直接运行源码（需先 `npm install`）：

```json
{
  "mcpServers": {
    "gsc": {
      "command": "npx",
      "args": ["tsx", "J:\\project\\gsc-mcp\\src\\index.ts"],
      "env": {
        "GSC_OAUTH_CLIENT_SECRETS_FILE": "C:\\path\\to\\client_secrets.json"
      }
    }
  }
}
```

## 打包后版

先执行 `npm run build` 编译，然后用 `node` 运行构建产物：

```json
{
  "mcpServers": {
    "gsc": {
      "command": "node",
      "args": [
        "J:\\project\\gsc-mcp\\build\\index.js"
      ],
      "env": {
        "GSC_OAUTH_CLIENT_SECRETS_FILE": "C:\\path\\to\\client_secrets.json"
      }
    }
  }
}
```

## macOS / Linux

```json
{
  "mcpServers": {
    "gsc": {
      "command": "node",
      "args": [
        "/path/to/gsc-mcp/build/index.js"
      ],
      "env": {
        "GSC_OAUTH_CLIENT_SECRETS_FILE": "/path/to/client_secrets.json"
      }
    }
  }
}
```

## 服务账号认证

将 `GSC_OAUTH_CLIENT_SECRETS_FILE` 替换为 `GSC_CREDENTIALS_PATH`：

```json
{
  "mcpServers": {
    "gsc": {
      "command": "node",
      "args": ["J:\\project\\gsc-mcp\\build\\index.js"],
      "env": {
        "GSC_CREDENTIALS_PATH": "C:\\path\\to\\service_account_credentials.json",
        "GSC_SKIP_OAUTH": "true"
      }
    }
  }
}
```

## 环境变量参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GSC_OAUTH_CLIENT_SECRETS_FILE` | — | OAuth 客户端密钥 JSON 绝对路径 |
| `GSC_CREDENTIALS_PATH` | — | 服务账号凭据 JSON 绝对路径 |
| `GSC_SKIP_OAUTH` | `false` | 设为 `true` 跳过 OAuth 仅用服务账号 |
| `GSC_ALLOW_DESTRUCTIVE` | `false` | 设为 `true` 启用 add/delete 操作 |
| `GSC_DATA_STATE` | `all` | `all` 或 `final`（已确认数据） |
| `GSC_CONFIG_DIR` | 平台默认 | 覆盖 token 存储目录 |
| `MCP_TRANSPORT` | `stdio` | `stdio` 或 `sse` |
| `MCP_HOST` | `127.0.0.1` | SSE 绑定地址 |
| `MCP_PORT` | `3001` | SSE 绑定端口 |
