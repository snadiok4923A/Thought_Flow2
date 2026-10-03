// Tiny static server for the mock-ChatGPT harness.
// Serves the chrome-extension/ folder so the harness page can load the REAL
// content scripts (utils/debug.js, content/*.js) with relative paths.
//   node serve.js  →  http://localhost:5099/test/mock-chatgpt.html
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const root = path.resolve(__dirname, "..");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    const rel = url === "/" ? "/test/mock-chatgpt.html" : url;
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(5099, () => console.log("mock chatgpt: http://localhost:5099/test/mock-chatgpt.html"));
