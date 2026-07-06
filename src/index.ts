import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getGscClient, reauthenticate, ALLOW_DESTRUCTIVE, DATA_STATE } from "./auth.js";
import type { OAuth2Client } from "google-auth-library";

/** GSC API 基础 URL */
const GSC_API_BASE = "https://searchconsole.googleapis.com/";

/** 创建 MCP 服务器实例 */
const server = new McpServer({
  name: "gsc-server",
  version: "1.0.0",
});

/**
 * 使用已认证的 client 调用 GSC REST API
 */
async function gscRequest<T = unknown>(
  client: OAuth2Client,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("Failed to get access token");

  const url = `${GSC_API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token.token}`,
    "Content-Type": "application/json",
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    let errMsg = text;
    try {
      const parsed = JSON.parse(text);
      errMsg = parsed?.error?.message || text;
    } catch { /* use raw text */ }
    const err = new Error(`GSC API error (${response.status}): ${errMsg}`);
    (err as unknown as Record<string, unknown>).status = response.status;
    throw err;
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** 站点未找到错误帮助信息 */
function siteNotFoundError(siteUrl: string): string {
  const lines = [`Property '${siteUrl}' not found (404). Possible causes:\n`];
  lines.push(
    "1. The site_url doesn't exactly match what is in GSC. Run list_properties to get the exact string to use."
  );
  if (siteUrl.startsWith("sc-domain:")) {
    lines.push(
      "2. Domain properties require the service account to be explicitly added under GSC Settings > Users and permissions for that specific domain property. " +
      "OAuth users must also have verified access to it."
    );
  } else {
    lines.push(
      "2. If your property is a domain property (covers all subdomains), the correct format is 'sc-domain:example.com', not a full URL."
    );
  }
  lines.push("3. The authenticated account may not have access to this property.");
  return lines.join("\n");
}

/** 格式化日期字符串 */
function formatDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    return d.toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return raw;
  }
}

// =============================================================================
// 工具注册
// =============================================================================

server.registerTool(
  "get_capabilities",
  {
    description:
      "获取所有可用工具的完整列表、当前认证状态以及入门指南。当被问及有哪些工具可用、此服务器能做什么或如何开始时，始终首先调用此工具。",
  },
  async () => {
    let authStatus: string;
    try {
      await getGscClient();
      authStatus = "✅ Authenticated — ready to use all tools.";
    } catch (e: unknown) {
      authStatus = `❌ Not authenticated — call the 'reauthenticate' tool first to open a browser login window.\nDetails: ${e instanceof Error ? e.message : String(e)}`;
    }

    const msg = `Google Search Console MCP Server

AUTH STATUS:
${authStatus}

GETTING STARTED:
1. If not authenticated, call the 'reauthenticate' tool to complete OAuth login.
2. Call 'list_properties' to see all your GSC sites and get the exact site_url for other tools.
3. Use any tool below with the site_url from step 2.

AVAILABLE TOOLS:

Authentication:
  - reauthenticate: Open browser OAuth login window. Call this if you see auth errors.

Properties:
  - list_properties: List all GSC sites/properties you have access to (start here)
  - get_site_details: Get verification and ownership details for a site

Analytics & Reporting:
  - get_search_analytics: Top queries and pages with clicks, impressions, CTR, position
  - get_performance_overview: Summary of site performance for a time period
  - compare_search_periods: Compare performance between two time periods
  - get_search_by_page_query: Search terms driving traffic to a specific page
  - get_advanced_search_analytics: Advanced filtering by country, device, query, page

URL Inspection & Indexing:
  - inspect_url_enhanced: Detailed crawl/index status for a specific URL
  - batch_url_inspection: Inspect up to 10 URLs at once
  - check_indexing_issues: Check multiple URLs for indexing problems

Sitemaps:
  - get_sitemaps: List all sitemaps for a site
  - list_sitemaps_enhanced: Detailed sitemap info including errors and warnings
  - get_sitemap_details: Get detailed information about a specific sitemap
  - submit_sitemap: Submit a new sitemap or resubmit an existing one
  - manage_sitemaps: Submit or delete sitemaps (requires GSC_ALLOW_DESTRUCTIVE=true for delete)

Destructive (disabled by default, set GSC_ALLOW_DESTRUCTIVE=true to enable):
  - add_site: Add a new property to GSC
  - delete_site: Remove a property from GSC
  - delete_sitemap: Remove a sitemap from GSC`;

    return { content: [{ type: "text" as const, text: msg }] };
  }
);

server.registerTool(
  "list_properties",
  {
    description:
      "列出用户可访问的所有 Google Search Console (GSC) 资产和站点。使用此工具查看已连接 Google Search Console 账户中的所有已验证站点、域名资产和 URL 前缀资产。请始终先调用此工具，以获取其他工具所需的精确 site_url。",
  },
  async () => {
    try {
      const client = await getGscClient();
      const data = await gscRequest<{ siteEntry?: Array<{ siteUrl: string; permissionLevel: string }> }>(
        client, "GET", "webmasters/v3/sites"
      );
      const sites = data.siteEntry || [];
      if (!sites.length) return { content: [{ type: "text" as const, text: "No Search Console properties found." }] };

      const result = {
        count: sites.length,
        properties: sites.map((s) => ({
          site_url: s.siteUrl || "Unknown",
          permission_level: s.permissionLevel || "Unknown",
        })),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text" as const, text: `Error retrieving properties: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

server.registerTool(
  "add_site",
  {
    description: "向 Search Console 添加站点。",
    inputSchema: {
      site_url: z.string().describe("要添加的站点 URL，例如 https://example.com/ 或 sc-domain:example.com"),
    },
  },
  async ({ site_url }) => {
    if (!ALLOW_DESTRUCTIVE) {
      return {
        content: [{
          type: "text" as const,
          text: "Safety: add_site is a destructive operation that modifies your GSC account. Set GSC_ALLOW_DESTRUCTIVE=true in your environment to enable add/delete tools.",
        }],
      };
    }
    try {
      const client = await getGscClient();
      const response = await gscRequest<{ permissionLevel?: string }>(client, "PUT", `webmasters/v3/sites/${encodeURIComponent(site_url)}`);
      const lines = [`Site ${site_url} has been added to Search Console.`];
      if (response?.permissionLevel) lines.push(`Permission level: ${response.permissionLevel}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = (e as unknown as Record<string, unknown>).status as number | undefined;
      if (status === 409) return { content: [{ type: "text" as const, text: `Site ${site_url} is already added to Search Console.` }] };
      if (status === 403) {
        // 尝试从错误消息中区分具体原因
        const lowerMsg = msg.toLowerCase();
        if (lowerMsg.includes("forbidden")) {
          return { content: [{ type: "text" as const, text: "Error: You don't have permission to add this site. Please verify ownership first." }] };
        }
        if (lowerMsg.includes("quota") || lowerMsg.includes("quotaexceeded")) {
          return { content: [{ type: "text" as const, text: "Error: API quota exceeded. Please try again later." }] };
        }
        return { content: [{ type: "text" as const, text: `Error: Permission denied. ${msg}` }] };
      }
      if (status === 400) {
        if (msg.toLowerCase().includes("invalid")) {
          return { content: [{ type: "text" as const, text: "Error: Invalid site URL format. Please check the URL format and try again." }] };
        }
        return { content: [{ type: "text" as const, text: `Error: Bad request. ${msg}` }] };
      }
      if (status === 401) return { content: [{ type: "text" as const, text: "Error: Unauthorized. Please check your credentials." }] };
      if (status === 429) return { content: [{ type: "text" as const, text: "Error: Too many requests. Please try again later." }] };
      if (status === 500) return { content: [{ type: "text" as const, text: "Error: Internal server error from Google Search Console API. Please try again later." }] };
      if (status === 503) return { content: [{ type: "text" as const, text: "Error: Service unavailable. Google Search Console API is currently down. Please try again later." }] };
      return { content: [{ type: "text" as const, text: `Error adding site (HTTP ${status || "unknown"}): ${msg}` }] };
    }
  }
);

server.registerTool(
  "delete_site",
  {
    description: "从 Search Console 删除站点。",
    inputSchema: {
      site_url: z.string().describe("要删除的站点 URL，例如 https://example.com/ 或 sc-domain:example.com"),
    },
  },
  async ({ site_url }) => {
    if (!ALLOW_DESTRUCTIVE) {
      return {
        content: [{
          type: "text" as const,
          text: "Safety: delete_site permanently removes a property from your GSC account. Set GSC_ALLOW_DESTRUCTIVE=true in your environment to enable add/delete tools.",
        }],
      };
    }
    try {
      const client = await getGscClient();
      await gscRequest(client, "DELETE", `webmasters/v3/sites/${encodeURIComponent(site_url)}`);
      return { content: [{ type: "text" as const, text: `Site ${site_url} has been removed from Search Console.` }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = (e as unknown as Record<string, unknown>).status as number | undefined;
      if (status === 404) return { content: [{ type: "text" as const, text: `Site ${site_url} was not found in Search Console.` }] };
      if (status === 403) {
        const lowerMsg = msg.toLowerCase();
        if (lowerMsg.includes("forbidden")) {
          return { content: [{ type: "text" as const, text: "Error: You don't have permission to remove this site." }] };
        }
        if (lowerMsg.includes("quota") || lowerMsg.includes("quotaexceeded")) {
          return { content: [{ type: "text" as const, text: "Error: API quota exceeded. Please try again later." }] };
        }
        return { content: [{ type: "text" as const, text: `Error: Permission denied. ${msg}` }] };
      }
      if (status === 400) {
        if (msg.toLowerCase().includes("invalid")) {
          return { content: [{ type: "text" as const, text: "Error: Invalid site URL format. Please check the URL format and try again." }] };
        }
        return { content: [{ type: "text" as const, text: `Error: Bad request. ${msg}` }] };
      }
      if (status === 401) return { content: [{ type: "text" as const, text: "Error: Unauthorized. Please check your credentials." }] };
      if (status === 429) return { content: [{ type: "text" as const, text: "Error: Too many requests. Please try again later." }] };
      if (status === 500) return { content: [{ type: "text" as const, text: "Error: Internal server error from Google Search Console API. Please try again later." }] };
      if (status === 503) return { content: [{ type: "text" as const, text: "Error: Service unavailable. Google Search Console API is currently down. Please try again later." }] };
      return { content: [{ type: "text" as const, text: `Error removing site (HTTP ${status || "unknown"}): ${msg}` }] };
    }
  }
);

server.registerTool(
  "get_site_details",
  {
    description: "获取特定 Search Console 资产的详细信息。",
    inputSchema: {
      site_url: z.string().describe("来自 list_properties 的精确 GSC 资产 URL，例如 https://example.com/ 或 sc-domain:example.com"),
    },
  },
  async ({ site_url }) => {
    try {
      const client = await getGscClient();
      const siteInfo = await gscRequest<Record<string, unknown>>(client, "GET", `webmasters/v3/sites/${encodeURIComponent(site_url)}`);

      const result: Record<string, unknown> = {
        site_url,
        permission_level: siteInfo.permissionLevel || "Unknown",
      };

      if (siteInfo.siteVerificationInfo) {
        const vi = siteInfo.siteVerificationInfo as Record<string, unknown>;
        result.verification = {
          state: vi.verificationState || "Unknown",
          verified_user: vi.verifiedUser,
          method: vi.verificationMethod,
        };
      }

      if (siteInfo.ownershipInfo) {
        const oi = siteInfo.ownershipInfo as Record<string, unknown>;
        result.ownership = {
          owner: oi.owner || "Unknown",
          verification_method: oi.verificationMethod,
        };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if ((e as Record<string, unknown>).status === 404) {
        return { content: [{ type: "text" as const, text: siteNotFoundError(site_url) }] };
      }
      return { content: [{ type: "text" as const, text: `Error retrieving site details: ${msg}` }] };
    }
  }
);

server.registerTool(
  "get_search_analytics",
  {
    description: "获取特定资产在 Google Search Console 中的搜索分析数据。",
    inputSchema: {
      site_url: z.string().describe("来自 list_properties 的精确 GSC 资产 URL"),
      days: z.number().int().default(28).describe("回溯天数（默认 28）"),
      dimensions: z.string().default("query").describe("分组维度，逗号分隔（如 query,page,device,country,date）"),
      row_limit: z.number().int().min(1).max(500).default(20).describe("返回行数（默认 20，最大 500）"),
    },
  },
  async ({ site_url, days = 28, dimensions = "query", row_limit = 20 }) => {
    try {
      const client = await getGscClient();
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const dimList = dimensions.split(",").map((d) => d.trim());
      const body = {
        startDate: startDate.toISOString().slice(0, 10),
        endDate: endDate.toISOString().slice(0, 10),
        dimensions: dimList,
        rowLimit: Math.min(Math.max(1, row_limit), 500),
        dataState: DATA_STATE,
      };

      const response = await gscRequest<{ rows?: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }> }>(
        client, "POST", `webmasters/v3/sites/${encodeURIComponent(site_url)}/searchAnalytics/query`, body
      );

      if (!response.rows?.length) {
        return { content: [{ type: "text" as const, text: `No search analytics data found for ${site_url} in the last ${days} days.` }] };
      }

      const rows = response.rows.map((row) => {
        const entry: Record<string, unknown> = {};
        dimList.forEach((dim, i) => {
          entry[dim] = row.keys?.[i] ?? null;
        });
        entry.clicks = row.clicks || 0;
        entry.impressions = row.impressions || 0;
        entry.ctr = Math.round((row.ctr || 0) * 10000) / 10000;
        entry.position = Math.round((row.position || 0) * 10) / 10;
        return entry;
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            site_url,
            date_range: { start: body.startDate, end: body.endDate, days },
            dimensions: dimList,
            row_count: rows.length,
            rows,
          }, null, 2),
        }],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("404")) return { content: [{ type: "text" as const, text: siteNotFoundError(site_url) }] };
      return { content: [{ type: "text" as const, text: `Error retrieving search analytics: ${msg}` }] };
    }
  }
);

server.registerTool(
  "get_performance_overview",
  {
    description: "获取特定资产的性能概览摘要。",
    inputSchema: {
      site_url: z.string().describe("来自 list_properties 的精确 GSC 资产 URL"),
      days: z.number().int().default(28).describe("回溯天数（默认 28）"),
    },
  },
  async ({ site_url, days = 28 }) => {
    try {
      const client = await getGscClient();
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const dateRange = {
        startDate: startDate.toISOString().slice(0, 10),
        endDate: endDate.toISOString().slice(0, 10),
      };

      // 获取总计
      const totalBody = { ...dateRange, dimensions: [], rowLimit: 1, dataState: DATA_STATE };
      const totalResponse = await gscRequest<{ rows?: Array<{ clicks: number; impressions: number; ctr: number; position: number }> }>(
        client, "POST", `webmasters/v3/sites/${encodeURIComponent(site_url)}/searchAnalytics/query`, totalBody
      );

      // 获取每日趋势
      const dateBody = { ...dateRange, dimensions: ["date"], rowLimit: days, dataState: DATA_STATE };
      const dateResponse = await gscRequest<{ rows?: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }> }>(
        client, "POST", `webmasters/v3/sites/${encodeURIComponent(site_url)}/searchAnalytics/query`, dateBody
      );

      if (!totalResponse.rows?.length) {
        return { content: [{ type: "text" as const, text: `No performance data available for ${site_url} in the last ${days} days.` }] };
      }

      const tr = totalResponse.rows[0];
      const totals = {
        clicks: tr.clicks || 0,
        impressions: tr.impressions || 0,
        ctr: Math.round((tr.ctr || 0) * 10000) / 10000,
        position: Math.round((tr.position || 0) * 10) / 10,
      };

      const dailyTrend = (dateResponse.rows || [])
        .sort((a, b) => (a.keys[0] || "").localeCompare(b.keys[0] || ""))
        .map((row) => ({
          date: row.keys[0],
          clicks: row.clicks || 0,
          impressions: row.impressions || 0,
          ctr: Math.round((row.ctr || 0) * 10000) / 10000,
          position: Math.round((row.position || 0) * 10) / 10,
        }));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ site_url, date_range: { ...dateRange, days }, totals, daily_trend: dailyTrend }, null, 2),
        }],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("404")) return { content: [{ type: "text" as const, text: siteNotFoundError(site_url) }] };
      return { content: [{ type: "text" as const, text: `Error retrieving performance overview: ${msg}` }] };
    }
  }
);

server.registerTool(
  "get_advanced_search_analytics",
  {
    description: "获取支持排序、过滤和分页的高级搜索分析数据。",
    inputSchema: {
      site_url: z.string().describe("来自 list_properties 的精确 GSC 资产 URL"),
      start_date: z.string().optional().describe("开始日期 YYYY-MM-DD（默认 28 天前）"),
      end_date: z.string().optional().describe("结束日期 YYYY-MM-DD（默认今天）"),
      dimensions: z.string().default("query").describe("分组维度，逗号分隔（如 query,page,device）"),
      search_type: z.string().default("WEB").describe("搜索类型: WEB, IMAGE, VIDEO, NEWS, DISCOVER"),
      row_limit: z.number().int().default(1000).describe("最大返回行数（最大 25000）"),
      start_row: z.number().int().default(0).describe("分页起始行"),
      sort_by: z.string().default("clicks").describe("排序指标: clicks, impressions, ctr, position"),
      sort_direction: z.string().default("descending").describe("排序方向: ascending 或 descending"),
      filter_dimension: z.string().optional().describe("单个过滤维度: query, page, country, device"),
      filter_operator: z.string().default("contains").describe("过滤操作符: contains, equals, notContains, notEquals"),
      filter_expression: z.string().optional().describe("过滤表达式值"),
      filters: z.string().optional().describe('JSON 数组格式的多过滤器，例如 [{"dimension":"country","operator":"equals","expression":"usa"}]'),
      data_state: z.string().optional().describe('数据新鲜度: "all"（默认）或 "final"（已确认数据，延迟 2-3 天）'),
    },
  },
  async (params) => {
    try {
      const client = await getGscClient();

      const endDate = params.end_date || new Date().toISOString().slice(0, 10);
      const s = new Date();
      s.setDate(s.getDate() - 28);
      const startDate = params.start_date || s.toISOString().slice(0, 10);

      const resolvedDataState = (params.data_state || DATA_STATE).toLowerCase().trim();
      if (!["all", "final"].includes(resolvedDataState)) {
        return { content: [{ type: "text" as const, text: `Invalid data_state value '${params.data_state}'. Accepted values are 'all' or 'final'.` }] };
      }

      const dimList = params.dimensions.split(",").map((d) => d.trim());

      const body: Record<string, unknown> = {
        startDate,
        endDate,
        dimensions: dimList,
        rowLimit: Math.min(params.row_limit, 25000),
        startRow: params.start_row,
        searchType: params.search_type.toUpperCase(),
        dataState: resolvedDataState,
      };

      // 排序
      const metricMap: Record<string, string> = {
        clicks: "CLICK_COUNT",
        impressions: "IMPRESSION_COUNT",
        ctr: "CTR",
        position: "POSITION",
      };
      if (params.sort_by && metricMap[params.sort_by]) {
        body.orderBy = [{ metric: metricMap[params.sort_by], direction: params.sort_direction.toLowerCase() }];
      }

      // 过滤器
      let activeFilters: Array<{ dimension: string; operator: string; expression: string }> = [];
      if (params.filters) {
        try {
          const filterList = JSON.parse(params.filters);
          if (!Array.isArray(filterList) || !filterList.length) {
            return { content: [{ type: "text" as const, text: "Invalid filters value. Expected a non-empty JSON array of filter objects." }] };
          }
          for (const f of filterList) {
            if (!f.dimension || !f.operator || !f.expression) {
              return { content: [{ type: "text" as const, text: "Each filter object must have 'dimension', 'operator', and 'expression' keys." }] };
            }
          }
          body.dimensionFilterGroups = [{ filters: filterList }];
          activeFilters = filterList;
        } catch {
          return { content: [{ type: "text" as const, text: "Invalid filters JSON. Please provide a valid JSON array of filter objects." }] };
        }
      } else if (params.filter_dimension && params.filter_expression) {
        const singleFilter = {
          dimension: params.filter_dimension,
          operator: params.filter_operator,
          expression: params.filter_expression,
        };
        body.dimensionFilterGroups = [{ filters: [singleFilter] }];
        activeFilters = [singleFilter];
      }

      const response = await gscRequest<{ rows?: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }> }>(
        client, "POST", `webmasters/v3/sites/${encodeURIComponent(params.site_url)}/searchAnalytics/query`, body
      );

      if (!response.rows?.length) {
        let noDataMsg = `No search analytics data found for ${params.site_url} with the specified parameters.\n\nParameters used:\n- Date range: ${startDate} to ${endDate}\n- Dimensions: ${params.dimensions}\n- Search type: ${params.search_type}\n`;
        if (activeFilters.length) {
          noDataMsg += "- Filters:\n";
          for (const f of activeFilters) {
            noDataMsg += `    ${f.dimension} ${f.operator} '${f.expression}'\n`;
          }
        } else {
          noDataMsg += "- No filter applied\n";
        }
        return { content: [{ type: "text" as const, text: noDataMsg }] };
      }

      const rows = response.rows.map((row) => {
        const entry: Record<string, unknown> = {};
        dimList.forEach((dim, i) => {
          entry[dim] = row.keys?.[i] ?? null;
        });
        entry.clicks = row.clicks || 0;
        entry.impressions = row.impressions || 0;
        entry.ctr = Math.round((row.ctr || 0) * 10000) / 10000;
        entry.position = Math.round((row.position || 0) * 10) / 10;
        return entry;
      });

      const hasMore = response.rows.length === params.row_limit;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            site_url: params.site_url,
            date_range: { start: startDate, end: endDate },
            search_type: params.search_type,
            dimensions: dimList,
            filters_applied: activeFilters,
            pagination: {
              start_row: params.start_row,
              row_count: rows.length,
              has_more: hasMore,
              next_start_row: hasMore ? params.start_row + params.row_limit : null,
            },
            rows,
          }, null, 2),
        }],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("404")) return { content: [{ type: "text" as const, text: siteNotFoundError(params.site_url) }] };
      return { content: [{ type: "text" as const, text: `Error retrieving advanced search analytics: ${msg}` }] };
    }
  }
);

server.registerTool(
  "compare_search_periods",
  {
    description: "比较两个时间段之间的搜索分析数据。",
    inputSchema: {
      site_url: z.string().describe("来自 list_properties 的精确 GSC 资产 URL"),
      period1_start: z.string().describe("第一个时间段的开始日期 (YYYY-MM-DD)"),
      period1_end: z.string().describe("第一个时间段的结束日期 (YYYY-MM-DD)"),
      period2_start: z.string().describe("第二个时间段的开始日期 (YYYY-MM-DD)"),
      period2_end: z.string().describe("第二个时间段的结束日期 (YYYY-MM-DD)"),
      dimensions: z.string().default("query").describe("分组维度（默认: query）"),
      limit: z.number().int().default(10).describe("比较的顶部结果数量（默认: 10）"),
    },
  },
  async ({ site_url, period1_start, period1_end, period2_start, period2_end, dimensions = "query", limit = 10 }) => {
    try {
      const client = await getGscClient();
      const dimList = dimensions.split(",").map((d) => d.trim());

      const body1 = { startDate: period1_start, endDate: period1_end, dimensions: dimList, rowLimit: 1000, dataState: DATA_STATE };
      const body2 = { startDate: period2_start, endDate: period2_end, dimensions: dimList, rowLimit: 1000, dataState: DATA_STATE };

      const [p1Response, p2Response] = await Promise.all([
        gscRequest<{ rows?: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }> }>(
          client, "POST", `webmasters/v3/sites/${encodeURIComponent(site_url)}/searchAnalytics/query`, body1
        ),
        gscRequest<{ rows?: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }> }>(
          client, "POST", `webmasters/v3/sites/${encodeURIComponent(site_url)}/searchAnalytics/query`, body2
        ),
      ]);

      const p1Rows = p1Response.rows || [];
      const p2Rows = p2Response.rows || [];

      if (!p1Rows.length && !p2Rows.length) {
        return { content: [{ type: "text" as const, text: `No data found for either period for ${site_url}.` }] };
      }

      const p1Data = new Map<string, { clicks: number; impressions: number; ctr: number; position: number }>();
      const p2Data = new Map<string, { clicks: number; impressions: number; ctr: number; position: number }>();

      for (const row of p1Rows) {
        p1Data.set(JSON.stringify(row.keys), { clicks: row.clicks || 0, impressions: row.impressions || 0, ctr: row.ctr || 0, position: row.position || 0 });
      }
      for (const row of p2Rows) {
        p2Data.set(JSON.stringify(row.keys), { clicks: row.clicks || 0, impressions: row.impressions || 0, ctr: row.ctr || 0, position: row.position || 0 });
      }

      const allKeys = new Set([...p1Data.keys(), ...p2Data.keys()]);
      const comparison: Array<Record<string, unknown>> = [];

      for (const key of allKeys) {
        const p1 = p1Data.get(key) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
        const p2 = p2Data.get(key) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };

        const clickDiff = p2.clicks - p1.clicks;
        const clickPct = p1.clicks > 0 ? (clickDiff / p1.clicks) * 100 : null;
        const impDiff = p2.impressions - p1.impressions;
        const impPct = p1.impressions > 0 ? (impDiff / p1.impressions) * 100 : null;

        comparison.push({
          key: JSON.parse(key) as string[],
          p1_clicks: p1.clicks,
          p2_clicks: p2.clicks,
          click_diff: clickDiff,
          click_pct: clickPct !== null ? Math.round(clickPct * 10) / 10 : null,
          p1_impressions: p1.impressions,
          p2_impressions: p2.impressions,
          imp_diff: impDiff,
          imp_pct: impPct !== null ? Math.round(impPct * 10) / 10 : null,
          p1_ctr: Math.round(p1.ctr * 10000) / 10000,
          p2_ctr: Math.round(p2.ctr * 10000) / 10000,
          ctr_diff: Math.round((p2.ctr - p1.ctr) * 10000) / 10000,
          p1_position: Math.round(p1.position * 10) / 10,
          p2_position: Math.round(p2.position * 10) / 10,
          position_diff: Math.round((p1.position - p2.position) * 10) / 10,
        });
      }

      comparison.sort((a, b) => Math.abs(b.click_diff as number) - Math.abs(a.click_diff as number));
      const top = comparison.slice(0, limit);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            site_url,
            period1: { start: period1_start, end: period1_end },
            period2: { start: period2_start, end: period2_end },
            dimensions: dimList,
            total_items: comparison.length,
            showing: top.length,
            comparison: top,
          }, null, 2),
        }],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("404")) return { content: [{ type: "text" as const, text: siteNotFoundError(site_url) }] };
      return { content: [{ type: "text" as const, text: `Error comparing search periods: ${msg}` }] };
    }
  }
);

server.registerTool(
  "get_search_by_page_query",
  {
    description: "获取特定页面的搜索分析数据，按查询细分。",
    inputSchema: {
      site_url: z.string().describe("来自 list_properties 的精确 GSC 资产 URL"),
      page_url: z.string().describe("要分析的特定页面 URL"),
      days: z.number().int().default(28).describe("回溯天数（默认 28）"),
      row_limit: z.number().int().min(1).max(500).default(20).describe("返回行数（默认 20，最大 500）"),
    },
  },
  async ({ site_url, page_url, days = 28, row_limit = 20 }) => {
    try {
      const client = await getGscClient();
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const body = {
        startDate: startDate.toISOString().slice(0, 10),
        endDate: endDate.toISOString().slice(0, 10),
        dimensions: ["query"],
        dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "equals", expression: page_url }] }],
        rowLimit: Math.min(Math.max(1, row_limit), 500),
        orderBy: [{ metric: "CLICK_COUNT", direction: "descending" }],
        dataState: DATA_STATE,
      };

      const response = await gscRequest<{ rows?: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }> }>(
        client, "POST", `webmasters/v3/sites/${encodeURIComponent(site_url)}/searchAnalytics/query`, body
      );

      if (!response.rows?.length) {
        return { content: [{ type: "text" as const, text: `No search data found for page ${page_url} in the last ${days} days.` }] };
      }

      const rows = response.rows.map((row) => ({
        query: row.keys?.[0] || "Unknown",
        clicks: row.clicks || 0,
        impressions: row.impressions || 0,
        ctr: Math.round((row.ctr || 0) * 10000) / 10000,
        position: Math.round((row.position || 0) * 10) / 10,
      }));

      const totalClicks = rows.reduce((sum, r) => sum + r.clicks, 0);
      const totalImpressions = rows.reduce((sum, r) => sum + r.impressions, 0);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            site_url,
            page_url,
            date_range: { start: body.startDate, end: body.endDate, days },
            totals: {
              clicks: totalClicks,
              impressions: totalImpressions,
              avg_ctr: totalImpressions > 0 ? Math.round((totalClicks / totalImpressions) * 10000) / 10000 : 0,
            },
            row_count: rows.length,
            rows,
          }, null, 2),
        }],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: `Error retrieving page query data: ${msg}` }] };
    }
  }
);

// URL Inspection 工具
server.registerTool(
  "inspect_url_enhanced",
  {
    description: "增强版 URL 检查，用于检查 Google 中的索引状态和富媒体搜索结果。",
    inputSchema: {
      site_url: z.string().describe("来自 list_properties 的精确 GSC 资产 URL"),
      page_url: z.string().describe("要检查的特定 URL"),
    },
  },
  async ({ site_url, page_url }) => {
    try {
      const client = await getGscClient();
      const body = { inspectionUrl: page_url, siteUrl: site_url };

      const response = await gscRequest<{ inspectionResult?: Record<string, unknown> }>(
        client, "POST", "v1/urlInspection/index:inspect", body
      );

      if (!response?.inspectionResult) {
        return { content: [{ type: "text" as const, text: `No inspection data found for ${page_url}.` }] };
      }

      const inspection = response.inspectionResult;
      const indexStatus = (inspection.indexStatusResult || {}) as Record<string, unknown>;

      let richResults: Record<string, unknown> | null = null;
      if (inspection.richResultsResult) {
        const rich = inspection.richResultsResult as Record<string, unknown>;
        richResults = {
          verdict: rich.verdict || "UNKNOWN",
          detected_types: ((rich.detectedItems as Array<{ richResultType?: string }>) || []).map((i) => i.richResultType || "Unknown"),
          issues: ((rich.richResultsIssues as Array<{ severity?: string; message?: string }>) || []).map((i) => ({ severity: i.severity, message: i.message })),
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            page_url,
            site_url,
            inspection_result_link: inspection.inspectionResultLink,
            verdict: indexStatus.verdict || "UNKNOWN",
            coverage_state: indexStatus.coverageState,
            last_crawled: formatDate(indexStatus.lastCrawlTime as string),
            page_fetch_state: indexStatus.pageFetchState,
            robots_txt_state: indexStatus.robotsTxtState,
            indexing_state: indexStatus.indexingState,
            google_canonical: indexStatus.googleCanonical,
            user_canonical: indexStatus.userCanonical,
            crawled_as: indexStatus.crawledAs,
            referring_urls: ((indexStatus.referringUrls as string[]) || []).slice(0, 5),
            rich_results: richResults,
          }, null, 2),
        }],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("404")) return { content: [{ type: "text" as const, text: siteNotFoundError(site_url) }] };
      return { content: [{ type: "text" as const, text: `Error inspecting URL: ${msg}` }] };
    }
  }
);

server.registerTool(
  "batch_url_inspection",
  {
    description: "批量检查多个 URL（在 API 限额内，最多 10 个）。",
    inputSchema: {
      site_url: z.string().describe("来自 list_properties 的精确 GSC 资产 URL"),
      urls: z.string().describe("要检查的 URL 列表，每行一个"),
    },
  },
  async ({ site_url, urls }) => {
    try {
      const client = await getGscClient();
      const urlList = urls.split("\n").map((u) => u.trim()).filter(Boolean);

      if (!urlList.length) return { content: [{ type: "text" as const, text: "No URLs provided for inspection." }] };
      if (urlList.length > 10) {
        return { content: [{ type: "text" as const, text: `Too many URLs provided (${urlList.length}). Please limit to 10 URLs per batch.` }] };
      }

      const results: Array<Record<string, unknown>> = [];
      for (const pageUrl of urlList) {
        try {
          const body = { inspectionUrl: pageUrl, siteUrl: site_url };
          const response = await gscRequest<{ inspectionResult?: Record<string, unknown> }>(
            client, "POST", "v1/urlInspection/index:inspect", body
          );

          if (!response?.inspectionResult) {
            results.push({ url: pageUrl, error: "No inspection data found" });
            continue;
          }

          const indexStatus = (response.inspectionResult.indexStatusResult || {}) as Record<string, unknown>;
          results.push({
            url: pageUrl,
            verdict: indexStatus.verdict || "UNKNOWN",
            coverage_state: indexStatus.coverageState || "Unknown",
            last_crawled: formatDate(indexStatus.lastCrawlTime as string) || "Never",
            rich_results: "None",
          });
        } catch (e: unknown) {
          results.push({ url: pageUrl, error: e instanceof Error ? e.message : String(e) });
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ site_url, count: results.length, results }, null, 2) }],
      };
    } catch (e: unknown) {
      return { content: [{ type: "text" as const, text: `Error performing batch inspection: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

server.registerTool(
  "check_indexing_issues",
  {
    description: "检查多个 URL 的特定索引问题。",
    inputSchema: {
      site_url: z.string().describe("来自 list_properties 的精确 GSC 资产 URL"),
      urls: z.string().describe("要检查的 URL 列表，每行一个"),
    },
  },
  async ({ site_url, urls }) => {
    try {
      const client = await getGscClient();
      const urlList = urls.split("\n").map((u) => u.trim()).filter(Boolean);

      if (!urlList.length) return { content: [{ type: "text" as const, text: "No URLs provided for inspection." }] };
      if (urlList.length > 10) {
        return { content: [{ type: "text" as const, text: `Too many URLs provided (${urlList.length}). Please limit to 10 URLs per batch.` }] };
      }

      const issuesSummary = {
        not_indexed: [] as string[],
        canonical_issues: [] as string[],
        robots_blocked: [] as string[],
        fetch_issues: [] as string[],
        indexed: [] as string[],
      };

      for (const pageUrl of urlList) {
        try {
          const body = { inspectionUrl: pageUrl, siteUrl: site_url };
          const response = await gscRequest<{ inspectionResult?: Record<string, unknown> }>(
            client, "POST", "v1/urlInspection/index:inspect", body
          );

          if (!response?.inspectionResult) {
            issuesSummary.not_indexed.push(`${pageUrl} - No inspection data found`);
            continue;
          }

          const indexStatus = (response.inspectionResult.indexStatusResult || {}) as Record<string, unknown>;
          const verdict = (indexStatus.verdict as string) || "UNKNOWN";
          const coverage = (indexStatus.coverageState as string) || "Unknown";

          if (verdict !== "PASS" || coverage.toLowerCase().includes("not indexed") || coverage.toLowerCase().includes("excluded")) {
            issuesSummary.not_indexed.push(`${pageUrl} - ${coverage}`);
          } else {
            issuesSummary.indexed.push(pageUrl);
          }

          const googleCanonical = (indexStatus.googleCanonical as string) || "";
          const userCanonical = (indexStatus.userCanonical as string) || "";
          if (googleCanonical && userCanonical && googleCanonical !== userCanonical) {
            issuesSummary.canonical_issues.push(`${pageUrl} - Google chose: ${googleCanonical} instead of user-declared: ${userCanonical}`);
          }

          if (indexStatus.robotsTxtState === "BLOCKED") {
            issuesSummary.robots_blocked.push(pageUrl);
          }

          const fetchState = indexStatus.pageFetchState as string;
          if (fetchState && fetchState !== "SUCCESSFUL") {
            issuesSummary.fetch_issues.push(`${pageUrl} - ${fetchState}`);
          }
        } catch (e: unknown) {
          issuesSummary.not_indexed.push(`${pageUrl} - Error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            site_url,
            summary: {
              total_checked: urlList.length,
              indexed: issuesSummary.indexed.length,
              not_indexed: issuesSummary.not_indexed.length,
              canonical_issues: issuesSummary.canonical_issues.length,
              robots_blocked: issuesSummary.robots_blocked.length,
              fetch_issues: issuesSummary.fetch_issues.length,
            },
            issues: {
              not_indexed: issuesSummary.not_indexed,
              canonical_issues: issuesSummary.canonical_issues,
              robots_blocked: issuesSummary.robots_blocked,
              fetch_issues: issuesSummary.fetch_issues,
            },
            indexed_urls: issuesSummary.indexed,
          }, null, 2),
        }],
      };
    } catch (e: unknown) {
      return { content: [{ type: "text" as const, text: `Error checking indexing issues: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

// Sitemap 工具
server.registerTool(
  "get_sitemaps",
  {
    description: "列出特定 Search Console 资产的所有站点地图。",
    inputSchema: {
      site_url: z.string().describe("来自 list_properties 的精确 GSC 资产 URL"),
    },
  },
  async ({ site_url }) => {
    try {
      const client = await getGscClient();
      const data = await gscRequest<{ sitemap?: Array<Record<string, unknown>> }>(
        client, "GET", `webmasters/v3/sites/${encodeURIComponent(site_url)}/sitemaps`
      );

      if (!data.sitemap?.length) {
        return { content: [{ type: "text" as const, text: `No sitemaps found for ${site_url}.` }] };
      }

      const sitemaps = data.sitemap.map((sm) => {
        const errors = Number(sm.errors || 0);
        const warnings = Number(sm.warnings || 0);
        let status = "Valid";
        if (errors > 0) status = "Has errors";
        else if (warnings > 0) status = "Has warnings";

        let indexedUrls: number | null = null;
        if (Array.isArray(sm.contents)) {
          for (const c of sm.contents as Array<{ type?: string; submitted?: number }>) {
            if (c.type === "web") { indexedUrls = c.submitted ?? null; break; }
          }
        }

        return {
          path: sm.path || "Unknown",
          last_downloaded: formatDate(sm.lastDownloaded as string),
          status,
          indexed_urls: indexedUrls,
          errors,
          warnings,
        };
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ site_url, count: sitemaps.length, sitemaps }, null, 2) }],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("404")) return { content: [{ type: "text" as const, text: siteNotFoundError(site_url) }] };
      return { content: [{ type: "text" as const, text: `Error retrieving sitemaps: ${msg}` }] };
    }
  }
);

server.registerTool(
  "list_sitemaps_enhanced",
  {
    description: "列出特定 Search Console 资产的所有站点地图，包含详细信息（错误、警告等）。",
    inputSchema: {
      site_url: z.string().describe("来自 list_properties 的精确 GSC 资产 URL"),
      sitemap_index: z.string().optional().describe("可选的站点地图索引 URL，用于列出子站点地图"),
    },
  },
  async ({ site_url, sitemap_index }) => {
    try {
      const client = await getGscClient();
      const queryPath = sitemap_index
        ? `webmasters/v3/sites/${encodeURIComponent(site_url)}/sitemaps?${new URLSearchParams({ sitemapIndex: sitemap_index })}`
        : `webmasters/v3/sites/${encodeURIComponent(site_url)}/sitemaps`;

      const data = await gscRequest<{ sitemap?: Array<Record<string, unknown>> }>(client, "GET", queryPath);

      if (!data.sitemap?.length) {
        return {
          content: [{
            type: "text" as const,
            text: `No sitemaps found for ${site_url}${sitemap_index ? ` in index ${sitemap_index}` : ""}.`,
          }],
        };
      }

      const sitemaps = data.sitemap.map((sm) => {
        let urlCount: number | null = null;
        if (Array.isArray(sm.contents)) {
          for (const c of sm.contents as Array<{ type?: string; submitted?: number }>) {
            if (c.type === "web") { urlCount = c.submitted ?? null; break; }
          }
        }
        return {
          path: sm.path || "Unknown",
          last_submitted: formatDate(sm.lastSubmitted as string),
          last_downloaded: formatDate(sm.lastDownloaded as string),
          type: sm.isSitemapsIndex ? "Index" : "Sitemap",
          is_pending: Boolean(sm.isPending),
          url_count: urlCount,
          errors: Number(sm.errors || 0),
          warnings: Number(sm.warnings || 0),
        };
      });

      const pendingCount = sitemaps.filter((s) => s.is_pending).length;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ site_url, sitemap_index: sitemap_index || null, count: sitemaps.length, pending_count: pendingCount, sitemaps }, null, 2),
        }],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("404")) return { content: [{ type: "text" as const, text: siteNotFoundError(site_url) }] };
      return { content: [{ type: "text" as const, text: `Error retrieving sitemaps: ${msg}` }] };
    }
  }
);

server.registerTool(
  "get_sitemap_details",
  {
    description: "获取特定站点地图的详细信息。",
    inputSchema: {
      site_url: z.string().describe("来自 list_properties 的精确 GSC 资产 URL"),
      sitemap_url: z.string().describe("要检查的站点地图的完整 URL"),
    },
  },
  async ({ site_url, sitemap_url }) => {
    try {
      const client = await getGscClient();
      const details = await gscRequest<Record<string, unknown>>(
        client, "GET", `webmasters/v3/sites/${encodeURIComponent(site_url)}/sitemaps/${encodeURIComponent(sitemap_url)}`
      );

      if (!details) return { content: [{ type: "text" as const, text: `No details found for sitemap ${sitemap_url}.` }] };

      const isIndex = Boolean(details.isSitemapsIndex);
      const contentBreakdown = (Array.isArray(details.contents) ? details.contents : []).map(
        (c: { type?: string; submitted?: number; indexed?: number }) => ({
          type: ((c.type as string) || "unknown").toUpperCase(),
          submitted: c.submitted || 0,
          indexed: c.indexed ?? null,
        })
      );

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            sitemap_url,
            site_url,
            type: isIndex ? "Index" : "Sitemap",
            status: details.isPending ? "pending" : "processed",
            last_submitted: formatDate(details.lastSubmitted as string),
            last_downloaded: formatDate(details.lastDownloaded as string),
            errors: Number(details.errors || 0),
            warnings: Number(details.warnings || 0),
            content_breakdown: contentBreakdown,
            is_index: isIndex,
          }, null, 2),
        }],
      };
    } catch (e: unknown) {
      return { content: [{ type: "text" as const, text: `Error retrieving sitemap details: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

server.registerTool(
  "submit_sitemap",
  {
    description: "向 Google 提交新的站点地图或重新提交现有站点地图。",
    inputSchema: {
      site_url: z.string().describe("来自 list_properties 的精确 GSC 资产 URL"),
      sitemap_url: z.string().describe("要提交的站点地图的完整 URL"),
    },
  },
  async ({ site_url, sitemap_url }) => {
    try {
      const client = await getGscClient();
      await gscRequest(client, "PUT", `webmasters/v3/sites/${encodeURIComponent(site_url)}/sitemaps/${encodeURIComponent(sitemap_url)}`);

      // 验证提交
      try {
        const details = await gscRequest<Record<string, unknown>>(
          client, "GET", `webmasters/v3/sites/${encodeURIComponent(site_url)}/sitemaps/${encodeURIComponent(sitemap_url)}`
        );
        const lines = [`Successfully submitted sitemap: ${sitemap_url}`];
        if (details.lastSubmitted) {
          lines.push(`Submission time: ${formatDate(details.lastSubmitted as string) || details.lastSubmitted}`);
        }
        lines.push(`Status: ${details.isPending ? "Pending processing" : "Processing started"}`);
        lines.push("\nNote: Google may take some time to process the sitemap. Check back later for full details.");
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch {
        return { content: [{ type: "text" as const, text: `Successfully submitted sitemap: ${sitemap_url}\n\nGoogle will queue it for processing.` }] };
      }
    } catch (e: unknown) {
      return { content: [{ type: "text" as const, text: `Error submitting sitemap: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

server.registerTool(
  "delete_sitemap",
  {
    description: "从 Google Search Console 删除（取消提交）站点地图。",
    inputSchema: {
      site_url: z.string().describe("来自 list_properties 的精确 GSC 资产 URL"),
      sitemap_url: z.string().describe("要删除的站点地图的完整 URL"),
    },
  },
  async ({ site_url, sitemap_url }) => {
    if (!ALLOW_DESTRUCTIVE) {
      return {
        content: [{
          type: "text" as const,
          text: "Safety: delete_sitemap permanently removes a sitemap from GSC. Set GSC_ALLOW_DESTRUCTIVE=true in your environment to enable add/delete tools.",
        }],
      };
    }
    try {
      const client = await getGscClient();
      // 检查站点地图是否存在
      try {
        await gscRequest(client, "GET", `webmasters/v3/sites/${encodeURIComponent(site_url)}/sitemaps/${encodeURIComponent(sitemap_url)}`);
      } catch (e: unknown) {
        if ((e as Record<string, unknown>).status === 404) {
          return { content: [{ type: "text" as const, text: `Sitemap not found: ${sitemap_url}. It may have already been deleted or was never submitted.` }] };
        }
        throw e;
      }

      await gscRequest(client, "DELETE", `webmasters/v3/sites/${encodeURIComponent(site_url)}/sitemaps/${encodeURIComponent(sitemap_url)}`);
      return {
        content: [{
          type: "text" as const,
          text: `Successfully deleted sitemap: ${sitemap_url}\n\nNote: This only removes the sitemap from Search Console. Any URLs already indexed will remain in Google's index.`,
        }],
      };
    } catch (e: unknown) {
      return { content: [{ type: "text" as const, text: `Error deleting sitemap: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

server.registerTool(
  "manage_sitemaps",
  {
    description: "管理站点地图的一体化工具（列表、详情、提交、删除）。",
    inputSchema: {
      site_url: z.string().describe("来自 list_properties 的精确 GSC 资产 URL"),
      action: z.string().describe("操作类型: list, details, submit, delete"),
      sitemap_url: z.string().optional().describe("站点地图的完整 URL（details、submit、delete 操作必需）"),
      sitemap_index: z.string().optional().describe("可选的站点地图索引 URL，用于列出子站点地图（仅用于 list 操作）"),
    },
  },
  async (params) => {
    const action = params.action.toLowerCase().trim();
    const validActions = ["list", "details", "submit", "delete"];
    if (!validActions.includes(action)) {
      return { content: [{ type: "text" as const, text: `Invalid action: ${params.action}. Please use one of: ${validActions.join(", ")}` }] };
    }
    if (["details", "submit", "delete"].includes(action) && !params.sitemap_url) {
      return { content: [{ type: "text" as const, text: `The ${action} action requires a sitemap_url parameter.` }] };
    }

    switch (action) {
      case "list":
        // 直接内联实现 list 操作
        try {
          const client = await getGscClient();
          const queryPath = params.sitemap_index
            ? `webmasters/v3/sites/${encodeURIComponent(params.site_url)}/sitemaps?${new URLSearchParams({ sitemapIndex: params.sitemap_index })}`
            : `webmasters/v3/sites/${encodeURIComponent(params.site_url)}/sitemaps`;
          const data = await gscRequest<{ sitemap?: Array<Record<string, unknown>> }>(client, "GET", queryPath);
          if (!data.sitemap?.length) {
            return { content: [{ type: "text" as const, text: `No sitemaps found for ${params.site_url}${params.sitemap_index ? ` in index ${params.sitemap_index}` : "."}` }] };
          }
          const sitemaps = data.sitemap.map((sm) => {
            let urlCount: number | null = null;
            if (Array.isArray(sm.contents)) {
              for (const c of sm.contents as Array<{ type?: string; submitted?: number }>) {
                if (c.type === "web") { urlCount = c.submitted ?? null; break; }
              }
            }
            return {
              path: sm.path || "Unknown",
              last_submitted: formatDate(sm.lastSubmitted as string),
              last_downloaded: formatDate(sm.lastDownloaded as string),
              type: sm.isSitemapsIndex ? "Index" : "Sitemap",
              is_pending: Boolean(sm.isPending),
              url_count: urlCount,
              errors: Number(sm.errors || 0),
              warnings: Number(sm.warnings || 0),
            };
          });
          return { content: [{ type: "text" as const, text: JSON.stringify({ site_url: params.site_url, count: sitemaps.length, sitemaps }, null, 2) }] };
        } catch (e: unknown) {
          return { content: [{ type: "text" as const, text: `Error listing sitemaps: ${e instanceof Error ? e.message : String(e)}` }] };
        }
      case "details":
        // 直接内联实现 details 操作
        try {
          const client = await getGscClient();
          const details = await gscRequest<Record<string, unknown>>(
            client, "GET", `webmasters/v3/sites/${encodeURIComponent(params.site_url)}/sitemaps/${encodeURIComponent(params.sitemap_url!)}`
          );
          if (!details) return { content: [{ type: "text" as const, text: `No details found for sitemap ${params.sitemap_url}.` }] };
          const isIndex = Boolean(details.isSitemapsIndex);
          const contentBreakdown = (Array.isArray(details.contents) ? details.contents : []).map(
            (c: { type?: string; submitted?: number; indexed?: number }) => ({
              type: ((c.type as string) || "unknown").toUpperCase(),
              submitted: c.submitted || 0,
              indexed: c.indexed ?? null,
            })
          );
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                sitemap_url: params.sitemap_url,
                site_url: params.site_url,
                type: isIndex ? "Index" : "Sitemap",
                status: details.isPending ? "pending" : "processed",
                last_submitted: formatDate(details.lastSubmitted as string),
                last_downloaded: formatDate(details.lastDownloaded as string),
                errors: Number(details.errors || 0),
                warnings: Number(details.warnings || 0),
                content_breakdown: contentBreakdown,
                is_index: isIndex,
              }, null, 2),
            }],
          };
        } catch (e: unknown) {
          return { content: [{ type: "text" as const, text: `Error retrieving sitemap details: ${e instanceof Error ? e.message : String(e)}` }] };
        }
      case "submit":
        // submit_sitemap
        try {
          const client = await getGscClient();
          await gscRequest(client, "PUT", `webmasters/v3/sites/${encodeURIComponent(params.site_url)}/sitemaps/${encodeURIComponent(params.sitemap_url!)}`);
          try {
            const details = await gscRequest<Record<string, unknown>>(
              client, "GET", `webmasters/v3/sites/${encodeURIComponent(params.site_url)}/sitemaps/${encodeURIComponent(params.sitemap_url!)}`
            );
            const lines = [`Successfully submitted sitemap: ${params.sitemap_url}`];
            if (details.lastSubmitted) lines.push(`Submission time: ${formatDate(details.lastSubmitted as string) || details.lastSubmitted}`);
            lines.push(`Status: ${details.isPending ? "Pending processing" : "Processing started"}`);
            lines.push("\nNote: Google may take some time to process the sitemap. Check back later for full details.");
            return { content: [{ type: "text" as const, text: lines.join("\n") }] };
          } catch {
            return { content: [{ type: "text" as const, text: `Successfully submitted sitemap: ${params.sitemap_url}\n\nGoogle will queue it for processing.` }] };
          }
        } catch (e: unknown) {
          return { content: [{ type: "text" as const, text: `Error submitting sitemap: ${e instanceof Error ? e.message : String(e)}` }] };
        }
      case "delete":
        if (!ALLOW_DESTRUCTIVE) {
          return { content: [{ type: "text" as const, text: "Safety: delete_sitemap permanently removes a sitemap from GSC. Set GSC_ALLOW_DESTRUCTIVE=true." }] };
        }
        try {
          const client = await getGscClient();
          try {
            await gscRequest(client, "GET", `webmasters/v3/sites/${encodeURIComponent(params.site_url)}/sitemaps/${encodeURIComponent(params.sitemap_url!)}`);
          } catch (e: unknown) {
            if ((e as Record<string, unknown>).status === 404) {
              return { content: [{ type: "text" as const, text: `Sitemap not found: ${params.sitemap_url}. It may have already been deleted or was never submitted.` }] };
            }
            throw e;
          }
          await gscRequest(client, "DELETE", `webmasters/v3/sites/${encodeURIComponent(params.site_url)}/sitemaps/${encodeURIComponent(params.sitemap_url!)}`);
          return { content: [{ type: "text" as const, text: `Successfully deleted sitemap: ${params.sitemap_url}\n\nNote: This only removes the sitemap from Search Console.` }] };
        } catch (e: unknown) {
          return { content: [{ type: "text" as const, text: `Error deleting sitemap: ${e instanceof Error ? e.message : String(e)}` }] };
        }
    }

    return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }] };
  }
);

server.registerTool(
  "reauthenticate",
  {
    description:
      "执行注销和新登录序列。删除当前 OAuth token 文件并触发浏览器认证流程。当需要切换到不同 Google 账户时使用。",
  },
  async () => {
    try {
      const msg = await reauthenticate();
      return { content: [{ type: "text" as const, text: msg }] };
    } catch (e: unknown) {
      return { content: [{ type: "text" as const, text: `Error during reauthentication: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

// =============================================================================
// 主函数 — 支持 stdio (默认) 和 SSE 传输
// =============================================================================

async function main() {
  const transportEnv = (process.env["MCP_TRANSPORT"] || "stdio").toLowerCase();
  const host = process.env["MCP_HOST"] || "127.0.0.1";
  const port = parseInt(process.env["MCP_PORT"] || "3001", 10);

  if (transportEnv === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("GSC MCP Server running on stdio");
  } else if (transportEnv === "sse" || transportEnv === "http") {
    // 使用 SSE 传输（通过 HTTP）绑定到指定的 host:port
    // 动态导入 SSE transport（仅在需要时加载）
    const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
    // SSE transport 在 Node.js 中通过 express/connect 中间件运行
    // 使用 POST 端点接收消息，GET 端点发送 SSE 事件流
    const { createServer } = await import("node:http");
    const httpServer = createServer(async (req, res) => {
      // 设置 CORS 头
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && req.url === "/sse") {
        // SSE 端点
        const transport = new SSEServerTransport("/message", res);
        await server.connect(transport);
        // transport 会处理 SSE 流的生命周期
        return;
      }

      if (req.method === "POST" && req.url === "/message") {
        // 消息端点 — 由 SSEServerTransport 处理
        // 注意：SSEServerTransport 在构造时接管了 response，所以 POST 需要单独处理
        // 此分支预留给未来的 SSE transport 实现
        res.writeHead(501);
        res.end("SSE message endpoint not yet implemented");
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    httpServer.listen(port, host, () => {
      console.error(`GSC MCP Server running on SSE at http://${host}:${port}/sse`);
    });
  } else {
    throw new Error(
      `Unknown MCP_TRANSPORT '${transportEnv}'. Use 'stdio' (default) or 'sse' / 'http'.`
    );
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
