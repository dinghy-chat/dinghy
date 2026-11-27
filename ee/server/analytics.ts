// Licensed under the Dinghy Enterprise License. See ee/LICENSE.

export async function captureWidgetInstall(
  { host, key }: { host: string; key: string },
  workspaceId: string,
): Promise<void> {
  const response = await fetch(`${host}/i/v0/e/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({
      api_key: key,
      event: "widget installed",
      distinct_id: `workspace:${workspaceId}`,
      properties: { workspace_id: workspaceId, $process_person_profile: false, $ip: null },
    }),
  });
  if (!response.ok) throw new Error(`PostHog capture returned ${response.status}`);
}
