# SQL Server MCP Server

A small Model Context Protocol (MCP) server that connects to Microsoft SQL Server and exposes database schema and query tools to an MCP client such as VS Code or the MCP Inspector.

## Requirements

- Node.js and npm
- Network access to the SQL Server host and port
- A SQL Server login with only the permissions required by your use case

## Setup

Install dependencies:

```powershell
npm install
```

Create a local `.env` file in the project root for command-line runs:

```dotenv
DB_SERVER=your-sql-server-host
DB_NAME=your-database
DB_PORT=1433
DB_USER=your-read-only-user
DB_PASSWORD=your-password
```

Do not commit `.env` or real credentials. The repository's `.gitignore` excludes `.env`. The current `mcp.json` uses an absolute Windows source path; update it if you clone the project elsewhere.

The connection uses encryption and trusts the server certificate. Review `trustServerCertificate` in `src/index.ts` for production environments and use a certificate configuration appropriate for your infrastructure.

## Run Locally

Start the server in watch mode:

```powershell
npm run dev
```

Build and run the compiled server:

```powershell
npm run build
npm start
```

Open the MCP Inspector:

```powershell
npm run inspect
```

The server uses the stdio transport. When launching it from an MCP client, the client must be able to run `npx tsx src/index.ts`, and the process must receive the database environment variables. The repository's root `mcp.json` uses an `mcpServers` configuration format; add the server to your MCP client's configuration if that client does not automatically discover this file. Update the source path for your local checkout.

## Available Tools

### `get_database_schema`

Lists base tables and their columns and data types using `INFORMATION_SCHEMA`. Views are not included by the current query.

### `execute_tsql_query`

Runs a T-SQL query and returns its result set as JSON. It is intended for `SELECT` statements and common table expressions (`WITH`). The current implementation checks only the beginning of the query string; this is not a complete security boundary. Use a dedicated SQL login with read-only permissions and do not rely on this check to prevent writes.

Example:

```sql
SELECT TOP (20)
    i.Code,
    i.Label1,
    i.PhysicalQuantity
FROM dbo.COM_Item AS i
ORDER BY i.Label1;
```

### `get_unsold_products_for_ui`

Returns a UI table resource, but its product rows are currently hard-coded sample data. It does not query SQL Server yet. The tool requires `days` and `tenantId` inputs; only `days` has a default.

## Creating Schemas and Tables

The current MCP server does not expose a database DDL tool. Create schemas and tables through an approved database administration workflow, such as SSMS, Azure Data Studio, or database migrations. Do not try to use `execute_tsql_query` for DDL.

Example T-SQL to run through an authorized database administration connection:

```sql
IF SCHEMA_ID(N'reporting') IS NULL
    EXEC(N'CREATE SCHEMA reporting AUTHORIZATION dbo;');
GO

IF OBJECT_ID(N'reporting.ProductAlert', N'U') IS NULL
BEGIN
    CREATE TABLE reporting.ProductAlert
    (
        AlertId BIGINT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ProductAlert PRIMARY KEY,
        ItemCode NVARCHAR(50) NOT NULL,
        AlertMessage NVARCHAR(500) NOT NULL,
        CreatedAt DATETIME2(0) NOT NULL
            CONSTRAINT DF_ProductAlert_CreatedAt DEFAULT SYSUTCDATETIME()
    );
END;
GO
```

To support DDL through MCP, add a separate, explicitly authorized tool with strict input validation and least-privilege permissions. Keep it separate from the query tool.

## Security Notes

- Never commit database credentials. The current `mcp.json` has credentials in clear text; replace them locally and rotate them if they are real and have been exposed.
- Prefer a read-only SQL login for this server.
- Restrict network access to the SQL Server host and port.
- Treat the query prefix check in `execute_tsql_query` as insufficient on its own; enforce permissions in SQL Server as well.
- Review certificate settings before using the connection in production.
