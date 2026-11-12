const READ_TIMEOUT_MS = 5000;

/** Reads a server-sent event stream as text until `until` appears, then closes it. */
export async function readStream(response: Response, until = "event: ready"): Promise<string> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + READ_TIMEOUT_MS;
  while (reader !== undefined && !text.includes(until) && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  await reader?.cancel();
  return text;
}
