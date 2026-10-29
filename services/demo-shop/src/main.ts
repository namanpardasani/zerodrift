import { startShop } from './shop.js';

const port = Number(process.env.PORT ?? 3009);
startShop({
  port,
  paymentsUrl: process.env.PAYMENTS_URL ?? 'http://payments:3002',
  webhookUrl: process.env.WEBHOOK_URL ?? 'http://webhook:3003',
  adminToken: process.env.ADMIN_TOKEN ?? 'dev-admin-token',
  publicUrl: process.env.PUBLIC_URL ?? `http://demo-shop:${port}`,
  staticDir: process.env.STATIC_DIR ?? '../../apps/shop/dist',
  log: (m) => console.log(m),
})
  .then((s) => console.log(`demo shop listening on ${s.url}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
