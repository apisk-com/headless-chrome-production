// Two fake internal services on 127.0.0.1 for the examples: an admin page
// on port 8170 and a cloud metadata endpoint on port 8169. All values are
// fake. Each request shows in the log, so you can see what got through.
import { createServer } from 'node:http';

const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 8170);
const METADATA_PORT = Number(process.env.METADATA_PORT ?? 8169);

createServer((req, res) => {
  console.log(`admin: ${req.method} ${req.url}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<body style="margin: 0; padding: 10px 14px; font: 15px/1.5 sans-serif; background: #fee2e2">
<b>Internal admin panel</b><br>Customers: 1,284<br>Database: db-main.internal:5432</body>`);
}).listen(ADMIN_PORT, '127.0.0.1');

createServer((req, res) => {
  console.log(`metadata: ${req.method} ${req.url}`);
  res.setHeader('Content-Type', 'text/plain');
  res.end(JSON.stringify({
    Code: 'Success',
    Type: 'AWS-HMAC',
    AccessKeyId: 'FAKE-ACCESS-KEY-ID',
    SecretAccessKey: 'FAKE-SECRET-ACCESS-KEY',
    Token: 'FAKE-SESSION-TOKEN',
  }, null, 2));
}).listen(METADATA_PORT, '127.0.0.1');

console.log(`Fake admin page on http://127.0.0.1:${ADMIN_PORT}/admin`);
console.log(`Fake metadata on http://127.0.0.1:${METADATA_PORT}/latest/meta-data/`);
