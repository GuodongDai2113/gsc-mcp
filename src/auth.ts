import { OAuth2Client, CodeChallengeMethod, GoogleAuth } from "google-auth-library";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as crypto from "node:crypto";
import * as http from "node:http";
import open from "open";

/** Google Search Console API 认证范围 */
const SCOPES = ["https://www.googleapis.com/auth/webmasters"];

/**
 * 展开路径中的 ~ 和环境变量
 * 同时支持 Unix $VAR / ${VAR} 和 Windows %VAR% 语法
 */
function expandPath(raw: string): string {
  let expanded = raw;
  // 展开 ~ 为用户目录
  if (expanded.startsWith("~")) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  // Unix 风格: $VAR 和 ${VAR}
  expanded = expanded.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || "");
  expanded = expanded.replace(/\$([A-Za-z_]\w*)/g, (_, name) => process.env[name] || "");
  // Windows 风格: %VAR%
  expanded = expanded.replace(/%([^%]+)%/g, (_, name) => process.env[name] || "");
  return expanded;
}

/** 脚本所在目录 */
const SCRIPT_DIR = (() => {
  // 编译后 __dirname 指向 build/，需要回退到 src/ 以查找凭据文件
  // 当用户 clone 安装时，凭据文件放在 src/ 目录下
  const dir = path.dirname(fileURLToPath(import.meta.url));
  if (/[\\/]build[\\/]?$/.test(dir)) {
    return dir.replace(/[\\/]build[\\/]?$/, path.sep + "src");
  }
  return dir;
})();

/** 凭据路径配置 */
const GSC_CREDENTIALS_PATH = process.env["GSC_CREDENTIALS_PATH"]
  ? expandPath(process.env["GSC_CREDENTIALS_PATH"])
  : null;

const POSSIBLE_CREDENTIAL_PATHS: (string | null)[] = [
  GSC_CREDENTIALS_PATH,
  path.join(SCRIPT_DIR, "service_account_credentials.json"),
  path.join(process.cwd(), "service_account_credentials.json"),
];

/** OAuth 客户端密钥文件路径 — 延后到 getGscClient() 调用时校验 */
const GSC_OAUTH_CLIENT_SECRETS_FILE = (() => {
  const env = process.env["GSC_OAUTH_CLIENT_SECRETS_FILE"];
  if (env) {
    const expanded = expandPath(env);
    return expanded;
  }
  return path.join(SCRIPT_DIR, "client_secrets.json");
})();

/** OAuth 密钥文件是否为用户显式设置 */
const GSC_OAUTH_CLIENT_SECRETS_FILE_EXPLICIT =
  process.env["GSC_OAUTH_CLIENT_SECRETS_FILE"] !== undefined;

/** Token 文件存放路径 — 优先使用 GSC_CONFIG_DIR，其次使用平台标准配置目录 */
function getConfigDir(): string {
  const envDir = process.env["GSC_CONFIG_DIR"];
  if (envDir) return expandPath(envDir);
  // Windows: %APPDATA%/mcp-gsc, 其他: ~/.config/mcp-gsc
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"] || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "mcp-gsc");
  }
  return path.join(os.homedir(), ".config", "mcp-gsc");
}

const CONFIG_DIR = getConfigDir();
fs.mkdirSync(CONFIG_DIR, { recursive: true });
const TOKEN_FILE = path.join(CONFIG_DIR, "token.json");

/** 迁移旧 token 文件 */
const OLD_TOKEN = path.join(SCRIPT_DIR, "token.json");
if (fs.existsSync(OLD_TOKEN) && !fs.existsSync(TOKEN_FILE)) {
  fs.renameSync(OLD_TOKEN, TOKEN_FILE);
}

/** 跳过 OAuth 认证 */
const SKIP_OAUTH = ["true", "1", "yes"].includes(
  (process.env["GSC_SKIP_OAUTH"] || "").toLowerCase()
);

/** 安全操作开关 */
const ALLOW_DESTRUCTIVE = ["true", "1", "yes"].includes(
  (process.env["GSC_ALLOW_DESTRUCTIVE"] || "false").toLowerCase()
);

/** 数据新鲜度 */
const rawDataState = (process.env["GSC_DATA_STATE"] || "all").toLowerCase().trim();
if (!["all", "final"].includes(rawDataState)) {
  throw new Error(
    `Invalid GSC_DATA_STATE value '${rawDataState}'. ` +
    "Accepted values are 'all' (default, matches GSC dashboard) or 'final' (2-3 day lag)."
  );
}
const DATA_STATE = rawDataState;

export { SCOPES, ALLOW_DESTRUCTIVE, DATA_STATE, TOKEN_FILE, SKIP_OAUTH };

/**
 * 生成用于 OAuth PKCE 的 code_verifier 和 code_challenge
 */
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(verifier).digest();
  const challenge = hash.toString("base64url");
  return { verifier, challenge };
}

/**
 * 获取 OAuth 2.0 认证的客户端
 * 支持浏览器打开进行登录授权
 */
async function getOAuthClient(): Promise<OAuth2Client> {
  const secretsRaw = fs.readFileSync(GSC_OAUTH_CLIENT_SECRETS_FILE, "utf-8");
  const secrets = JSON.parse(secretsRaw);

  const installed = secrets.installed || secrets.web;
  if (!installed) {
    throw new Error(
      "Invalid OAuth client secrets file. Expected 'installed' or 'web' key with client_id and client_secret."
    );
  }

  // 使用 client_secrets 中配置的 redirect_uri，或者 http://localhost
  const baseRedirectUri = installed.redirect_uris?.[0] || "http://localhost";

  const client = new OAuth2Client({
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
    redirectUri: baseRedirectUri,
  });

  // 尝试从 token 文件加载
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
      client.setCredentials(tokens);

      // 如果 token 已过期/即将过期，尝试刷新
      const expiryDate = client.credentials.expiry_date;
      if (expiryDate && expiryDate <= Date.now() + 300000) {
        try {
          const { credentials } = await client.refreshAccessToken();
          client.setCredentials(credentials);
          fs.writeFileSync(TOKEN_FILE, JSON.stringify(credentials, null, 2));
        } catch {
          // 刷新失败，删除旧 token 并回退到新 OAuth 流程（与 Python 行为一致）
          if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
          // 清除已设置的无效凭据
          client.setCredentials({});
        }
      }

      // 如果凭据仍有效（未过期或刷新成功），直接返回
      if (client.credentials.access_token) {
        return client;
      }
    } catch {
      // token 文件损坏，删除并回退到新 OAuth 流程
      if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    }
  }

  // 需要新的 OAuth 流程
  if (!fs.existsSync(GSC_OAUTH_CLIENT_SECRETS_FILE)) {
    throw new Error(
      "OAuth client secrets file not found. Please place a client_secrets.json file in the script directory " +
      "or set the GSC_OAUTH_CLIENT_SECRETS_FILE environment variable."
    );
  }

  // 生成 PKCE 参数
  const { verifier, challenge } = generatePKCE();

  // 启动本地回调节器，获取实际端口
  const port = await new Promise<number>((resolve, reject) => {
    const testServer = http.createServer();
    testServer.listen(0, "127.0.0.1", () => {
      const addr = testServer.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        testServer.close(() => resolve(p));
      } else {
        testServer.close(() => reject(new Error("Failed to get port")));
      }
    });
    testServer.on("error", reject);
  });

  // 使用实际端口构建 redirect URI
  const redirectUri = `http://${new URL(baseRedirectUri).hostname}:${port}`;

  // 重新创建 OAuth2Client，使用正确的 redirectUri
  const oauthClient = new OAuth2Client({
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
    redirectUri,
  });

  // 构建授权 URL
  const authUrl = oauthClient.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: challenge,
  });

  // 打开浏览器
  console.error("Opening browser for Google authentication...");
  await open(authUrl);

  // 启动本地回调节器并等待授权码
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h1>Authentication Failed</h1><p>Error: ${error}</p></body></html>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authentication Successful!</h1><p>You can close this window.</p></body></html>");
        server.close();
        resolve(code);
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Google Search Console MCP</h1><p>Waiting for authentication...</p></body></html>");
    });

    server.listen(port, "127.0.0.1");

    server.on("error", reject);
  });

  // 用授权码换取 token
  const { tokens } = await oauthClient.getToken({ code, codeVerifier: verifier });
  oauthClient.setCredentials(tokens);

  // 保存 token
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));

  return oauthClient;
}

/**
 * 获取服务账号认证的客户端
 */
async function getServiceAccountClient(): Promise<OAuth2Client | null> {
  for (const credPath of POSSIBLE_CREDENTIAL_PATHS) {
    if (credPath && fs.existsSync(credPath)) {
      try {
        const auth = new GoogleAuth({
          keyFile: credPath,
          scopes: SCOPES,
        });
        const client = await auth.getClient();
        if (client instanceof OAuth2Client) {
          return client;
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * 获取已认证的 Google OAuth2Client
 * 先尝试 OAuth 认证，再尝试服务账号认证
 */
export async function getGscClient(): Promise<OAuth2Client> {
  // 快速失败检查：如果凭据环境变量被设置但文件不存在
  if (GSC_CREDENTIALS_PATH && !fs.existsSync(GSC_CREDENTIALS_PATH)) {
    throw new Error(
      `GSC_CREDENTIALS_PATH is set to ${JSON.stringify(GSC_CREDENTIALS_PATH)} but the file does not exist. ` +
      `If running via npx, this MUST be an absolute path to your service account credentials JSON file.`
    );
  }
  if (GSC_OAUTH_CLIENT_SECRETS_FILE_EXPLICIT && !fs.existsSync(GSC_OAUTH_CLIENT_SECRETS_FILE)) {
    throw new Error(
      `GSC_OAUTH_CLIENT_SECRETS_FILE is set to ${JSON.stringify(GSC_OAUTH_CLIENT_SECRETS_FILE)} ` +
      `but the file does not exist. ` +
      `If running via npx, this MUST be an absolute path to your OAuth client_secrets.json file.`
    );
  }

  // 先尝试 OAuth 认证
  if (!SKIP_OAUTH) {
    try {
      console.error("Attempting OAuth authentication...");
      return await getOAuthClient();
    } catch (e: unknown) {
      console.error("OAuth authentication failed:", e instanceof Error ? e.message : String(e));
    }
  }

  // 尝试服务账号认证
  const saClient = await getServiceAccountClient();
  if (saClient) {
    return saClient;
  }

  throw new Error(
    "Authentication failed. Please either:\n" +
    "1. Set up OAuth by setting GSC_OAUTH_CLIENT_SECRETS_FILE to an absolute path, " +
    "or (for clone installs) placing a client_secrets.json file in the script directory, " +
    "then call the 'reauthenticate' tool to open a browser login window " +
    "and complete authentication, or\n" +
    "2. Set GSC_CREDENTIALS_PATH to an absolute path, or (for clone installs) " +
    "place a service account credentials file in one of these locations: " +
    `${POSSIBLE_CREDENTIAL_PATHS.filter(Boolean).join(", ")}\n` +
    "\n" +
    "If you installed via npx, the 'script directory' is an internal npm cache " +
    "that you cannot access — you MUST use the environment variables with " +
    "absolute paths."
  );
}

/**
 * 执行 OAuth 重新认证
 * 删除现有 token 并启动新的浏览器认证流程
 */
export async function reauthenticate(): Promise<string> {
  let tokenDeleted = false;
  if (fs.existsSync(TOKEN_FILE)) {
    fs.unlinkSync(TOKEN_FILE);
    tokenDeleted = true;
  }

  // 检查 OAuth 客户端密钥文件是否存在
  if (!fs.existsSync(GSC_OAUTH_CLIENT_SECRETS_FILE)) {
    throw new Error(
      "Error: OAuth client secrets file not found. " +
      "Cannot start new authentication flow. " +
      "Please ensure client_secrets.json is present or set the " +
      "GSC_OAUTH_CLIENT_SECRETS_FILE environment variable."
    );
  }

  // 触发新的 OAuth 流程（会打开浏览器）
  await getOAuthClient();

  const msg = tokenDeleted
    ? "Previous session deleted. Successfully authenticated with a new Google account."
    : "Successfully authenticated with a new Google account.";

  return msg;
}
