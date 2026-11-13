import { createServer } from "node:net";

/**
 * The least of an SMTP server, for a test that sends a few small emails: it accepts every message
 * and keeps its text.
 */
export async function fakeSmtp() {
  const received: string[] = [];
  const server = createServer((socket) => {
    let inData = false;
    let message = "";
    socket.write("220 test\r\n");
    socket.on("data", (chunk) => {
      for (const line of chunk.toString().split("\r\n").slice(0, -1)) {
        if (inData) {
          if (line === ".") {
            inData = false;
            received.push(message);
            socket.write("250 ok\r\n");
          } else message += `${line}\n`;
        } else if (line.startsWith("DATA")) {
          inData = true;
          message = "";
          socket.write("354 go\r\n");
        } else if (line.startsWith("QUIT")) socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `smtp://127.0.0.1:${port}`, received, close: () => server.close() };
}
