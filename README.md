# mcp-azure-blob

An MCP (Model Context Protocol) server that gives AI agents read, write, delete, and list access to Azure Blob Storage. Authentication uses your Azure identity — no storage keys or connection strings required.

Compatible with **Claude Code**, **GitHub Copilot**, **LM Studio**, **OpenClaw**, and **Microsoft Semantic Kernel**.

---

## Tools

| Tool | Description |
|---|---|
| `list_containers` | List all containers in the storage account, optionally filtered by name prefix |
| `list_blobs` | List blobs in a container, optionally filtered by path prefix |
| `read_blob` | Download and return the text content of a blob |
| `write_blob` | Upload text content to a blob (create or overwrite) |
| `delete_blob` | Delete a blob (soft-delete aware — see Azure notes below) |

---

## Prerequisites

### 1. Node.js
Version 18 or later. Download from [nodejs.org](https://nodejs.org).

### 2. Azure CLI
Required for `az login` authentication.
- **Windows:** [Install guide](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-windows)
- **macOS:** `brew install azure-cli`
- **Linux:** [Install guide](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-linux)

### 3. Sign in to Azure
```bash
az login
```
Your credentials are cached by the Azure CLI and picked up automatically by the server. No tokens or secrets need to be stored in configuration files.

### 4. Azure Role Assignment
Your account must have the **Storage Blob Data Contributor** role on the target storage account. Without it, all operations will return a 403 error.

Assign the role via the Azure CLI (replace the placeholders):
```bash
az role assignment create \
  --role "Storage Blob Data Contributor" \
  --assignee <your-email-or-object-id> \
  --scope "/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.Storage/storageAccounts/<storage-account-name>"
```

Or assign it in the Azure portal:
**Storage account → Access Control (IAM) → Add role assignment → Storage Blob Data Contributor**

---

## Installation

```bash
git clone <repo-url>
cd mcp-azure-blob
npm install
```

The `dist/` folder is included in the repository — no build step is needed.

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AZURE_STORAGE_ACCOUNT` | **Yes** | Storage account name only — not the full URL. Example: `mystorageaccount` |
| `AZURE_STORAGE_ALLOWED_CONTAINERS` | No | Comma-separated list of container names the agent is permitted to access. If omitted, all containers in the account are accessible. Example: `reports,archives` |

### mcp.json Structure

Add the following to your MCP host configuration. The `args` array takes a single entry — the full path to `dist/index.js` in the cloned repo.

```json
{
  "mcpServers": {
    "azure-blob": {
      "command": "node",
      "args": [
        "/path/to/mcp-azure-blob/dist/index.js"
      ],
      "env": {
        "AZURE_STORAGE_ACCOUNT": "your-storage-account-name",
        "AZURE_STORAGE_ALLOWED_CONTAINERS": "container1,container2"
      }
    }
  }
}
```

**Windows path example:**
```json
"args": ["C:/Users/yourname/repos/mcp-azure-blob/dist/index.js"]
```

**macOS / Linux path example:**
```json
"args": ["/home/yourname/repos/mcp-azure-blob/dist/index.js"]
```

### Host-Specific Locations

| Host | Config file location |
|---|---|
| Claude Code | `~/.claude/claude_desktop_config.json` or workspace `.mcp.json` |
| GitHub Copilot | `.vscode/mcp.json` in your workspace |
| LM Studio | Settings → MCP → Edit config |
| OpenClaw | Settings → MCP Servers |
| Semantic Kernel | Configured programmatically via `McpClientPlugin` |

---

## Azure-Side Assumptions

The server is designed around the following Azure storage configuration. It will work with any Azure Blob Storage account that meets these conditions:

- **Authentication:** Entra ID (Azure AD) RBAC. Shared key access may also be enabled on the account, but this server always uses identity-based auth.
- **Public network access:** Enabled. If your account uses private endpoints or firewall rules, the machine running the MCP server must be on an allowed network.
- **TLS:** HTTPS only (`supportsHttpsTrafficOnly: true`). This is enforced by the Azure SDK.
- **Soft delete:** If blob soft-delete is enabled on the account, deleted blobs are not immediately removed — they are recoverable for the retention period configured on the account. The server will indicate this in the delete response.
- **Public blob access:** Not required. The server authenticates as your identity and does not rely on anonymous access.
- **Container access:** All containers should have `publicAccess: None`. The server handles access via RBAC, not public URLs.

---

## Authentication Flow

The server uses a credential chain in this priority order:

1. **Azure CLI** (`az login`) — recommended for local development
2. **Environment variables** — `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`
3. **Managed Identity** — when running inside Azure (VMs, App Service, Container Apps, etc.)
4. **Other DefaultAzureCredential sources** — Visual Studio, VS Code Azure extension, Workload Identity

For local use, running `az login` is all that is needed.

---

## Rebuilding from Source

If you modify `src/index.ts`, rebuild with:

```bash
npm run build
```

Requires TypeScript (`npm install` handles this via `devDependencies`).
