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
export {};
//# sourceMappingURL=index.d.ts.map