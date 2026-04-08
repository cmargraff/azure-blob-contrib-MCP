#!/usr/bin/env node

/**
 * MCP Azure Blob Storage Server
 *
 * Auth priority (via DefaultAzureCredential):
 *   1. Azure CLI  (az login)            ← primary for local dev
 *   2. Environment variables            ← AZURE_CLIENT_ID / TENANT_ID / CLIENT_SECRET
 *   3. Managed Identity                 ← when running in Azure
 *   4. Visual Studio / VS Code / etc.
 *
 * Required env var:
 *   AZURE_STORAGE_ACCOUNT  — storage account name (not the full URL)
 *
 * Optional env vars:
 *   AZURE_STORAGE_ALLOWED_CONTAINERS — comma-separated list of containers to
 *                                      restrict access to. If unset, all
 *                                      containers in the account are accessible.
 *
 * Compatible hosts: Claude Code, GitHub Copilot, LM Studio,
 *                   OpenClaw, Microsoft Semantic Kernel
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  BlobServiceClient,
  BlobItem,
  ContainerItem,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import {
  DefaultAzureCredential,
  AzureCliCredential,
  ChainedTokenCredential,
} from "@azure/identity";

// ─── Config ───────────────────────────────────────────────────────────────────

const STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT ?? "";
if (!STORAGE_ACCOUNT) {
  process.stderr.write(
    "Fatal: AZURE_STORAGE_ACCOUNT environment variable is required.\n"
  );
  process.exit(1);
}

const ACCOUNT_URL = `https://${STORAGE_ACCOUNT}.blob.core.windows.net`;

const ALLOWED_CONTAINERS: Set<string> | null = process.env
  .AZURE_STORAGE_ALLOWED_CONTAINERS
  ? new Set(
      process.env.AZURE_STORAGE_ALLOWED_CONTAINERS.split(",").map((s) =>
        s.trim()
      )
    )
  : null; // null = no restriction

// ─── Auth ─────────────────────────────────────────────────────────────────────

// AzureCliCredential first (az login token, cached by the Azure CLI)
// then DefaultAzureCredential for all other sources (env vars, managed identity, etc.)
const credential = new ChainedTokenCredential(
  new AzureCliCredential(),
  new DefaultAzureCredential()
);

const blobServiceClient = new BlobServiceClient(ACCOUNT_URL, credential);

// ─── Guards ───────────────────────────────────────────────────────────────────

function assertContainerAllowed(container: string): void {
  if (ALLOWED_CONTAINERS && !ALLOWED_CONTAINERS.has(container)) {
    throw new Error(
      `Container "${container}" is not in the allowed list. ` +
        `Allowed: ${[...ALLOWED_CONTAINERS].join(", ")}`
    );
  }
  if (!container || container.trim() === "") {
    throw new Error("Container name must not be empty.");
  }
}

// ─── Tool implementations ─────────────────────────────────────────────────────

async function listContainers(prefix?: string): Promise<string> {
  const results: string[] = [];

  for await (const container of blobServiceClient.listContainers({
    prefix,
    includeMetadata: true,
  })) {
    const c = container as ContainerItem;
    const allowed =
      !ALLOWED_CONTAINERS || ALLOWED_CONTAINERS.has(c.name) ? "" : " [restricted]";
    const meta = c.metadata
      ? Object.entries(c.metadata)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
      : "";
    results.push(
      `${c.name}${allowed}${meta ? `  (${meta})` : ""}`
    );
  }

  if (results.length === 0) return "No containers found.";
  return `Containers in ${STORAGE_ACCOUNT}:\n` + results.join("\n");
}

async function listBlobs(
  container: string,
  prefix?: string,
  maxResults = 100
): Promise<string> {
  assertContainerAllowed(container);
  const containerClient = blobServiceClient.getContainerClient(container);
  const blobs: string[] = [];
  let count = 0;

  for await (const blob of containerClient.listBlobsFlat({
    prefix,
    includeMetadata: true,
  })) {
    if (count >= maxResults) {
      blobs.push(`…and more (limit ${maxResults} reached)`);
      break;
    }
    const b = blob as BlobItem;
    const size = b.properties.contentLength ?? 0;
    const modified = b.properties.lastModified?.toISOString() ?? "?";
    const type = b.properties.contentType ?? "";
    blobs.push(`${b.name}  [${formatBytes(size)}  ${type}  ${modified}]`);
    count++;
  }

  if (blobs.length === 0) return `No blobs found in container "${container}".`;
  return (
    `Blobs in ${STORAGE_ACCOUNT}/${container}` +
    (prefix ? `/${prefix}` : "") +
    `:\n` +
    blobs.join("\n")
  );
}

async function readBlob(container: string, blobPath: string): Promise<string> {
  assertContainerAllowed(container);
  const blobClient = blobServiceClient
    .getContainerClient(container)
    .getBlobClient(blobPath);

  const properties = await blobClient.getProperties();
  const contentType = properties.contentType ?? "";
  const size = properties.contentLength ?? 0;

  // Refuse binary files > 1 MB — text extraction makes no sense
  const isBinary =
    !contentType.includes("text") &&
    !contentType.includes("json") &&
    !contentType.includes("xml") &&
    !contentType.includes("javascript") &&
    !contentType.includes("yaml");

  if (isBinary && size > 1_048_576) {
    return (
      `Blob "${blobPath}" appears to be binary (${contentType}, ${formatBytes(size)}). ` +
      `Download it directly via the Azure portal or CLI.`
    );
  }

  const download = await blobClient.downloadToBuffer();
  const text = download.toString("utf-8");

  const header =
    `Blob: ${STORAGE_ACCOUNT}/${container}/${blobPath}\n` +
    `Size: ${formatBytes(size)}  |  Type: ${contentType}  |  ` +
    `Modified: ${properties.lastModified?.toISOString() ?? "?"}\n\n`;

  return header + text;
}

async function writeBlob(
  container: string,
  blobPath: string,
  content: string,
  contentType = "text/plain; charset=utf-8",
  overwrite = true
): Promise<string> {
  assertContainerAllowed(container);
  const blockBlobClient = blobServiceClient
    .getContainerClient(container)
    .getBlockBlobClient(blobPath);

  const buffer = Buffer.from(content, "utf-8");
  await blockBlobClient.upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: contentType },
    conditions: overwrite ? {} : { ifNoneMatch: "*" },
  });

  return (
    `Written ${formatBytes(buffer.length)} to ` +
    `${STORAGE_ACCOUNT}/${container}/${blobPath}  (${contentType})`
  );
}

async function deleteBlob(
  container: string,
  blobPath: string,
  deleteSnapshots = true
): Promise<string> {
  assertContainerAllowed(container);
  const blobClient = blobServiceClient
    .getContainerClient(container)
    .getBlobClient(blobPath);

  await blobClient.delete({
    deleteSnapshots: deleteSnapshots ? "include" : undefined,
  });

  return (
    `Deleted ${STORAGE_ACCOUNT}/${container}/${blobPath}\n` +
    `Note: soft-delete is enabled on this account — the blob is recoverable ` +
    `for 7 days via the Azure portal or 'az storage blob undelete'.`
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "azure-blob", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_containers",
      description:
        "List all blob containers in the configured Azure Storage account. " +
        "Optionally filter by name prefix. Returns container names and metadata.",
      inputSchema: {
        type: "object",
        properties: {
          prefix: {
            type: "string",
            description: "Optional name prefix to filter containers",
          },
        },
      },
    },
    {
      name: "list_blobs",
      description:
        "List blobs inside a specific container. Optionally filter by path prefix " +
        "(e.g. 'reports/2025/'). Returns blob name, size, content type, and last modified date.",
      inputSchema: {
        type: "object",
        properties: {
          container: {
            type: "string",
            description: "Container name",
          },
          prefix: {
            type: "string",
            description:
              "Optional path prefix to filter blobs (e.g. 'folder/subfolder/')",
          },
          max_results: {
            type: "number",
            description: "Maximum number of blobs to return (default: 100)",
          },
        },
        required: ["container"],
      },
    },
    {
      name: "read_blob",
      description:
        "Download and return the text content of a blob. Suitable for text, " +
        "JSON, XML, Markdown, CSV and similar formats. Binary files larger than " +
        "1 MB will be declined with a message to use the Azure portal instead.",
      inputSchema: {
        type: "object",
        properties: {
          container: { type: "string", description: "Container name" },
          blob_path: {
            type: "string",
            description: "Full blob path within the container (e.g. 'folder/file.json')",
          },
        },
        required: ["container", "blob_path"],
      },
    },
    {
      name: "write_blob",
      description:
        "Upload text content to a blob. Creates the blob if it does not exist, " +
        "or overwrites it by default. Set overwrite=false to fail if the blob " +
        "already exists (safe write).",
      inputSchema: {
        type: "object",
        properties: {
          container: { type: "string", description: "Container name" },
          blob_path: {
            type: "string",
            description: "Destination blob path (e.g. 'reports/summary.txt')",
          },
          content: {
            type: "string",
            description: "Text content to upload",
          },
          content_type: {
            type: "string",
            description:
              "MIME type (default: 'text/plain; charset=utf-8'). " +
              "Use 'application/json' for JSON, 'text/markdown' for Markdown, etc.",
          },
          overwrite: {
            type: "boolean",
            description:
              "If false, the write will fail when the blob already exists (default: true)",
          },
        },
        required: ["container", "blob_path", "content"],
      },
    },
    {
      name: "delete_blob",
      description:
        "Permanently delete a blob from a container. Also deletes any snapshots " +
        "of the blob by default.",
      inputSchema: {
        type: "object",
        properties: {
          container: { type: "string", description: "Container name" },
          blob_path: {
            type: "string",
            description: "Full blob path to delete",
          },
          delete_snapshots: {
            type: "boolean",
            description:
              "Also delete snapshots of this blob (default: true)",
          },
        },
        required: ["container", "blob_path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_containers": {
        const result = await listContainers(args?.prefix as string | undefined);
        return { content: [{ type: "text", text: result }] };
      }

      case "list_blobs": {
        const container  = args?.container as string;
        const prefix     = args?.prefix as string | undefined;
        const maxResults = (args?.max_results as number) ?? 100;
        if (!container) throw new Error("'container' is required");
        const result = await listBlobs(container, prefix, maxResults);
        return { content: [{ type: "text", text: result }] };
      }

      case "read_blob": {
        const container = args?.container as string;
        const blobPath  = args?.blob_path as string;
        if (!container) throw new Error("'container' is required");
        if (!blobPath)  throw new Error("'blob_path' is required");
        const result = await readBlob(container, blobPath);
        return { content: [{ type: "text", text: result }] };
      }

      case "write_blob": {
        const container   = args?.container as string;
        const blobPath    = args?.blob_path as string;
        const content     = args?.content as string;
        const contentType = (args?.content_type as string) ?? "text/plain; charset=utf-8";
        const overwrite   = (args?.overwrite as boolean) ?? true;
        if (!container) throw new Error("'container' is required");
        if (!blobPath)  throw new Error("'blob_path' is required");
        if (content === undefined || content === null) throw new Error("'content' is required");
        const result = await writeBlob(container, blobPath, content, contentType, overwrite);
        return { content: [{ type: "text", text: result }] };
      }

      case "delete_blob": {
        const container       = args?.container as string;
        const blobPath        = args?.blob_path as string;
        const deleteSnapshots = (args?.delete_snapshots as boolean) ?? true;
        if (!container) throw new Error("'container' is required");
        if (!blobPath)  throw new Error("'blob_path' is required");
        const result = await deleteBlob(container, blobPath, deleteSnapshots);
        return { content: [{ type: "text", text: result }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const restriction = ALLOWED_CONTAINERS
    ? `containers: ${[...ALLOWED_CONTAINERS].join(", ")}`
    : "all containers";

  process.stderr.write(
    `MCP azure-blob v1.0.0 — account: ${STORAGE_ACCOUNT} — access: ${restriction}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
