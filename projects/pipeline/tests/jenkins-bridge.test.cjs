const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function waitForLine(stream, pattern, child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`bridge startup timed out: ${output}`)), 3000);
    const onData = (chunk) => {
      output += chunk;
      if (!pattern.test(output)) return;
      clearTimeout(timeout);
      stream.off("data", onData);
      resolve(output);
    };
    stream.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`bridge exited before startup (code ${code}): ${output}`));
    });
  });
}

function requestOptions(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "OPTIONS", path: "/" }, resolve);
    req.once("error", reject);
    req.end();
  });
}

test("Jenkins bridge binds to loopback by default", async (t) => {
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);

  const env = { ...process.env, BRIDGE_PORT: String(port), BRIDGE_TARGET: "http://127.0.0.1:1" };
  delete env.BRIDGE_BIND;
  const child = spawn(process.execPath, [path.join(__dirname, "..", "jenkins-bridge.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  const startup = await waitForLine(child.stdout, /\[bridge\] listening on /, child);
  assert.match(startup, new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`));

  const response = await requestOptions(port);
  response.resume();
  assert.equal(response.statusCode, 200);
});
