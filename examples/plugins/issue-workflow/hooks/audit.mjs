export default function audit(event) {
  if (!event.toolName?.startsWith("mcp_issue-workflow-")) {
    return;
  }

  process.stderr.write(
    `[issue-workflow:audit] ${event.toolName} policy=${event.action} risk=${event.risk}\n`,
  );
}
