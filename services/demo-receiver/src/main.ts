import { startReceiver } from './receiver.js';

// Demo merchant webhook receiver. RECEIVER_SECRETS = the endpoint secret(s) shown when the
// endpoint was created (comma separated to allow rotation overlap).
const secrets = (process.env.RECEIVER_SECRETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const port = Number(process.env.PORT ?? 3007);

startReceiver({ port, secrets, log: (m) => console.log(m) })
  .then((r) => console.log(`demo receiver listening on ${r.url} (POST /webhooks), ${secrets.length} secret(s) configured`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
