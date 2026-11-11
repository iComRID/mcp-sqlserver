import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import sql from "mssql";
import { z } from "zod";
import dotenv from 'dotenv';
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });
// 1. إعدادات الاتصال بـ SQL Server
const sqlConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    server: process.env.DB_SERVER || "inabex",
    port: Number(process.env.DB_PORT) || 1433,
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
    },
    options: {
        encrypt: true, // مطلوب في Azure والإصدارات الحديثة
        trustServerCertificate: true, // ضروري للاتصال المحلي (Localhost / Self-signed certs)
    },
};
// 2. تهيئة خادم MCP
const server = new McpServer({
    name: "sqlserver-mcp",
    version: "1.0.0",
});
// 3. أداة أولى: جلب قائمة الجداول والأعمدة في قاعدة البيانات
server.tool("get_database_schema", "استعراض جميع الجداول والأعمدة وأنواع البيانات داخل قاعدة بيانات SQL Server", {}, // إذا لم تكن هناك مدخلات، يترك كائنًا فارغًا
async () => {
    try {
        const pool = await sql.connect(sqlConfig);
        const result = await pool.request().query(`
        SELECT 
          t.TABLE_SCHEMA,
          t.TABLE_NAME,
          c.COLUMN_NAME,
          c.DATA_TYPE
        FROM INFORMATION_SCHEMA.TABLES t
        JOIN INFORMATION_SCHEMA.COLUMNS c 
          ON t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_SCHEMA = c.TABLE_SCHEMA
        WHERE t.TABLE_TYPE = 'BASE TABLE'
        ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION;
      `);
        return {
            content: [{ type: "text", text: JSON.stringify(result.recordset, null, 2) }],
        };
    }
    catch (err) {
        return {
            isError: true,
            content: [{ type: "text", text: `SQL Server Error: ${err.message}` }],
        };
    }
});
// 4. أداة ثانية: تنفيذ استعلامات SELECT فقط
server.tool("execute_tsql_query", "تنفيذ استعلام T-SQL للقراءة فقط (SELECT) على SQL Server", {
    query: z.string().describe("جملة استعلام SELECT بلغة T-SQL"),
}, async (args) => {
    const query = args.query;
    // تحقق مبدئي لمنع أوامر التعديل أو الحذف
    const normalizedQuery = query.trim().toUpperCase();
    if (!normalizedQuery.startsWith("SELECT") && !normalizedQuery.startsWith("WITH")) {
        return {
            isError: true,
            content: [{ type: "text", text: "خطأ أمني: يُسمح فقط باستعلامات SELECT أو CTE (WITH)." }],
        };
    }
    try {
        const pool = await sql.connect(sqlConfig);
        const result = await pool.request().query(query);
        return {
            content: [{ type: "text", text: JSON.stringify(result.recordset, null, 2) }],
        };
    }
    catch (err) {
        return {
            isError: true,
            content: [{ type: "text", text: `Query Execution Error: ${err.message}` }],
        };
    }
});
server.tool("get_unsold_products_for_ui", "جلب المنتجات الراكدة مع هيكلة البيانات لرسمها كجدول تفاعلي في التطبيق", {
    days: z.number().default(30),
    tenantId: z.number(),
}, async ({ days, tenantId }) => {
    // جلب البيانات من قاعدة البيانات...
    const products = [
        { id: 1, name: "لابتوب ديل", stock: 5, price: 1200 },
        { id: 2, name: "شاشة سامسونج", stock: 2, price: 300 },
    ];
    // إرجاع البيانات مهيكلة بشكل يفهمه الـ Backend والواجهة
    return {
        content: [
            {
                type: "text",
                text: `وجدت ${products.length} منتجات راكدة لم تُبع خلال الـ ${days} يوم الآتية.`,
            },
            {
                type: "resource", // أو نمررها داخل الـ text بصيغة JSON محددة
                resource: {
                    uri: "ui://widgets/products-table",
                    mimeType: "application/json",
                    text: JSON.stringify({
                        component: "TABLE",
                        title: "المنتجات الراكدة في المخزون",
                        columns: ["اسم المنتح", "الكمية المتبقية", "السعر"],
                        rows: products.map(p => [p.name, p.stock, p.price]),
                        actions: [
                            { label: "إنشاء خصم ترويجي", actionId: "apply_discount" }
                        ]
                    }),
                },
            },
        ],
    };
});
// 5. تشغيل الخادم
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("SQL Server MCP Server is running on stdio");
}
main();
//# sourceMappingURL=index.js.map