#!/usr/bin/env node

/**
 * MSSQL Model Context Protocol (MCP) Server
 * Built with @modelcontextprotocol/sdk, mssql, and Zod.
 * 
 * IMPORTANT:
 * Standard output (stdout) is strictly reserved for JSON-RPC messages.
 * ALWAYS use console.error for internal logs, diagnostics, and errors.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import sql from "mssql";
import { z } from "zod";
import dotenv from "dotenv";

// تحميل متغيرات البيئة من ملف .env في حال وجوده (مفيد للتطوير المحلي)
dotenv.config();

// ============================================================================
// 1. التحقق من متغيرات البيئة وإعداد مجمع الاتصال (Connection Pool)
// ============================================================================

const EnvConfigSchema = z.object({
  DB_SERVER: z.string().min(1, "DB_SERVER is required"),
  DB_NAME: z.string().min(1, "DB_NAME is required"),
  DB_USER: z.string().min(1, "DB_USER is required"),
  DB_PASSWORD: z.string().min(1, "DB_PASSWORD is required"),
  DB_PORT: z
    .string()
    .optional()
    .default("1433")
    .transform((val) => parseInt(val, 10))
    .refine((port) => !isNaN(port) && port > 0 && port <= 65535, {
      message: "DB_PORT must be a valid port number",
    }),
});

const envParsed = EnvConfigSchema.safeParse(process.env);
if (!envParsed.success) {
  console.error("[CRITICAL] Invalid environment configuration:");
  console.error(JSON.stringify(envParsed.error.format(), null, 2));
  process.exit(1);
}

const env = envParsed.data;

const dbConfig: sql.config = {
  server: env.DB_SERVER,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  port: env.DB_PORT,
  options: {
    encrypt: true, // ضروري للاتصالات المشفرة (Azure و SQL الحديثة)
    trustServerCertificate: true, // يمنع مشاكل الشهادات الموقعة ذاتياً في البيئات المحلية
    connectTimeout: 15000,
    requestTimeout: 30000,
  },
  pool: {
    max: 10,
    min: 2,
    idleTimeoutMillis: 30000,
  },
};

// إدارة Singleton لمجمع الاتصالات (Connection Pool)
let connectionPool: sql.ConnectionPool | null = null;

async function getPool(): Promise<sql.ConnectionPool> {
  if (connectionPool && connectionPool.connected) {
    return connectionPool;
  }

  try {
    console.error(`[DB] Establishing connection pool to ${env.DB_SERVER}:${env.DB_PORT}/${env.DB_NAME}...`);
    connectionPool = await new sql.ConnectionPool(dbConfig).connect();
    
    connectionPool.on("error", (err) => {
      console.error("[DB Pool Error]:", err);
    });

    console.error("[DB] Connected successfully to SQL Server.");
    return connectionPool;
  } catch (error) {
    console.error("[DB Connection Error]:", error);
    throw error;
  }
}

// ============================================================================
// 2. طبقة الحماية الصارمة للاستعلامات (Read-Only Guardrails)
// ============================================================================

/**
 * فحص استعلام T-SQL للتأكد التام من أنه للقراءة فقط (SELECT / WITH CTE)
 * ومنع أي محاولات تعديل، مسح، حقن، أو تنفيذ إجراءات مخزنة.
 */
function validateReadOnlyQuery(query: string): { isValid: boolean; reason?: string } {
  // 1. تنظيف التعليقات (Single-line و Multi-line) لمنع إخفاء أوامر خبيثة داخلها
  const strippedQuery = query
    .replace(/\/\*[\s\S]*?\*\//g, " ") // إزالة /* ... */
    .replace(/--.*$/gm, " ")           // إزالة -- ...
    .trim();

  if (!strippedQuery) {
    return { isValid: false, reason: "Query cannot be empty." };
  }

  // 2. التحقق من أن الاستعلام يبدأ حصراً بـ SELECT أو WITH (CTE)
  const startsWithAllowed = /^(SELECT|WITH)\b/i.test(strippedQuery);
  if (!startsWithAllowed) {
    return {
      isValid: false,
      reason: "Security Violation: Only read operations (SELECT or WITH statements) are permitted.",
    };
  }

  // 3. قائمة سوداء صارمة للكلمات المفتاحية التخريبية أو المسببة لتعديل البيانات
  const forbiddenPatterns: { pattern: RegExp; name: string }[] = [
    { pattern: /\b(INSERT|UPDATE|DELETE|MERGE)\b/i, name: "DML Modification (INSERT/UPDATE/DELETE/MERGE)" },
    { pattern: /\b(DROP|ALTER|CREATE|TRUNCATE)\b/i, name: "DDL Modification (DROP/ALTER/CREATE/TRUNCATE)" },
    { pattern: /\bINTO\b/i, name: "SELECT INTO (Table Creation)" },
    { pattern: /\b(EXEC|EXECUTE)\b/i, name: "Procedure/Command Execution" },
    { pattern: /\b(GRANT|REVOKE|DENY)\b/i, name: "Permission Modification" },
    { pattern: /\b(BACKUP|RESTORE|SHUTDOWN|KILL|BULK)\b/i, name: "Administrative Command" },
    { pattern: /\b(sp_|xp_)\w+/i, name: "System Stored Procedure Execution" },
  ];

  for (const { pattern, name } of forbiddenPatterns) {
    if (pattern.test(strippedQuery)) {
      return {
        isValid: false,
        reason: `Security Violation: Forbidden keyword or operation detected: [${name}].`,
      };
    }
  }

  // 4. منع تنفيذ عدة استعلامات متتالية تفصل بينها فاصلة منقوطة (Batching / Chaining attacks)
  const statements = strippedQuery
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (statements.length > 1) {
    // التأكد من أن كل استعلام منفصل هو أيضاً SELECT أو WITH
    for (const stmt of statements) {
      if (!/^(SELECT|WITH)\b/i.test(stmt)) {
        return {
          isValid: false,
          reason: "Security Violation: Chained query contains unauthorized non-SELECT statement.",
        };
      }
    }
  }

  return { isValid: true };
}

// ============================================================================
// 3. التحقق من صحة مدخلات الأدوات عبر Zod
// ============================================================================

const GetDatabaseSchemaInput = z.object({
  tableFilter: z
    .string()
    .optional()
    .describe("Optional table name to filter the schema inspection (e.g., 'Customers' or 'dbo.Orders')"),
});

const ExecuteTsqlQueryInput = z.object({
  query: z
    .string()
    .min(1, "The SQL query string cannot be empty")
    .describe("The T-SQL read-only query to execute (must start with SELECT or WITH)"),
  maxRows: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .default(100)
    .describe("Maximum number of rows to return (default: 100, max: 1000)"),
});

// ============================================================================
// 4. إعداد خادم MCP وتسجيل الأدوات (Tools Definition)
// ============================================================================

const server = new Server(
  {
    name: "mssql-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// تسجيل الأدوات المتاحة للنموذج (ListTools)
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_database_schema",
        description:
          "Retrieves the database structure including schemas, tables, views, columns, data types, and nullability constraints from INFORMATION_SCHEMA. Helps understand available data before querying.",
        inputSchema: {
          type: "object",
          properties: {
            tableFilter: {
              type: "string",
              description: "Optional specific table name to inspect (case-insensitive).",
            },
          },
        },
      },
      {
        name: "execute_tsql_query",
        description:
          "Executes a strictly read-only T-SQL query (SELECT or WITH) against the configured SQL Server database. Automatically blocks any data-modifying or structural altering commands.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The T-SQL SELECT or WITH query statement.",
            },
            maxRows: {
              type: "number",
              description: "Limit the maximum returned rows (default: 100, max: 1000).",
            },
          },
          required: ["query"],
        },
      },
    ],
  };
});

// تنفيذ الأدوات عند استدعائها (CallTool)
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;

  try {
    const pool = await getPool();

    // ------------------------------------------------------------------------
    // أداة: get_database_schema
    // ------------------------------------------------------------------------
    if (name === "get_database_schema") {
      const parsedArgs = GetDatabaseSchemaInput.safeParse(rawArgs || {});
      if (!parsedArgs.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Invalid arguments: ${parsedArgs.error.issues.map((e) => e.message).join(", ")}`,
            },
          ],
        };
      }

      const { tableFilter } = parsedArgs.data;

      const req = pool.request();
      let queryStr = `
        SELECT 
          c.TABLE_SCHEMA,
          c.TABLE_NAME,
          t.TABLE_TYPE,
          c.COLUMN_NAME,
          c.ORDINAL_POSITION,
          c.DATA_TYPE,
          c.CHARACTER_MAXIMUM_LENGTH,
          c.NUMERIC_PRECISION,
          c.NUMERIC_SCALE,
          c.IS_NULLABLE,
          c.COLUMN_DEFAULT
        FROM INFORMATION_SCHEMA.COLUMNS c
        INNER JOIN INFORMATION_SCHEMA.TABLES t 
          ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
      `;

      if (tableFilter) {
        // استخدام استعلام ذو معاملات (Parameterized Query) لحماية ضد الـ Injection
        queryStr += ` WHERE c.TABLE_NAME = @tableName OR (c.TABLE_SCHEMA + '.' + c.TABLE_NAME) = @tableName`;
        req.input("tableName", sql.NVarChar, tableFilter.trim());
      }

      queryStr += ` ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION;`;

      const result = await req.query(queryStr);

      if (result.recordset.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: tableFilter
                ? `No tables or columns found matching filter: "${tableFilter}".`
                : "The database has no user tables/views or current user lacks metadata permissions.",
            },
          ],
        };
      }

      // تنسيق المخرجات بشكل هرمي منظم (Hierarchical JSON) ليسهل على الـ LLM فهمه
      const schemaHierarchy: Record<
        string,
        {
          schema: string;
          name: string;
          type: string;
          columns: {
            name: string;
            type: string;
            nullable: boolean;
            default: string | null;
          }[];
        }
      > = {};

      for (const row of result.recordset) {
        const fullTableName = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
        if (!schemaHierarchy[fullTableName]) {
          schemaHierarchy[fullTableName] = {
            schema: row.TABLE_SCHEMA,
            name: row.TABLE_NAME,
            type: row.TABLE_TYPE,
            columns: [],
          };
        }

        const typeDetails = row.CHARACTER_MAXIMUM_LENGTH
          ? `${row.DATA_TYPE}(${row.CHARACTER_MAXIMUM_LENGTH === -1 ? "MAX" : row.CHARACTER_MAXIMUM_LENGTH})`
          : row.NUMERIC_PRECISION
          ? `${row.DATA_TYPE}(${row.NUMERIC_PRECISION}${row.NUMERIC_SCALE ? `,${row.NUMERIC_SCALE}` : ""})`
          : row.DATA_TYPE;

        schemaHierarchy[fullTableName].columns.push({
          name: row.COLUMN_NAME,
          type: typeDetails,
          nullable: row.IS_NULLABLE === "YES",
          default: row.COLUMN_DEFAULT,
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(Object.values(schemaHierarchy), null, 2),
          },
        ],
      };
    }

    // ------------------------------------------------------------------------
    // أداة: execute_tsql_query
    // ------------------------------------------------------------------------
    if (name === "execute_tsql_query") {
      const parsedArgs = ExecuteTsqlQueryInput.safeParse(rawArgs);
      if (!parsedArgs.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Invalid query arguments: ${parsedArgs.error.issues.map((e) => e.message).join(", ")}`,
            },
          ],
        };
      }

      const { query, maxRows } = parsedArgs.data;

      // 1. فحص الأمان
      const validation = validateReadOnlyQuery(query);
      if (!validation.isValid) {
        console.error(`[BLOCKED QUERY]: ${query}`);
        console.error(`[REASON]: ${validation.reason}`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Query Rejected: ${validation.reason}`,
            },
          ],
        };
      }

      // 2. تنفيذ الاستعلام مع تحديد سقف النتائج (ROWCOUNT) لحماية الذاكرة والأداء
      const request = pool.request();
      const wrappedQuery = `
        SET ROWCOUNT ${maxRows};
        ${query};
        SET ROWCOUNT 0;
      `;

      console.error(`[QUERY EXECUTION] Executing: ${query.substring(0, 100)}... (Limit: ${maxRows})`);
      const queryResult = await request.query(wrappedQuery);

      const rowsCount = queryResult.recordset ? queryResult.recordset.length : 0;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                rowCount: rowsCount,
                truncated: rowsCount >= maxRows,
                rows: queryResult.recordset || [],
              },
              null,
              2
            ),
          },
        ],
      };
    }

    throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
  } catch (error: any) {
    console.error(`[TOOL ERROR] Tool "${name}" failed:`, error);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Database Error: ${error.message || String(error)}`,
        },
      ],
    };
  }
});

// ============================================================================
// 5. بدء تشغيل الخادم عبر بروتوكول stdio والإغلاق النظيف (Graceful Shutdown)
// ============================================================================

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP SERVER] MSSQL MCP Server running on stdio transport.");
}

async function handleShutdown(signal: string) {
  console.error(`[SHUTDOWN] Received ${signal}. Closing MSSQL connection pool...`);
  if (connectionPool && connectionPool.connected) {
    try {
      await connectionPool.close();
      console.error("[SHUTDOWN] Connection pool closed cleanly.");
    } catch (err) {
      console.error("[SHUTDOWN ERROR] Error while closing pool:", err);
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

run().catch((error) => {
  console.error("[FATAL ERROR] Server crashed during startup:", error);
  process.exit(1);
});