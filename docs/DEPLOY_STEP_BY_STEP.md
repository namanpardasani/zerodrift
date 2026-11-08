# Deploy Zerodrift: step by step (one free VM + Docker Compose + free HTTPS)

Paste this whole file to an assistant if you want help while doing it. Everything below was prepared and tested locally; nothing here creates an account for you.

## Context an assistant needs

- Repo: https://github.com/namanpardasani/zerodrift (public). Node/TypeScript monorepo, 7 runtime services, Postgres 17, Kafka (KRaft, 1 broker), Redis, Caddy for HTTPS.
- Production Compose file: `deploy/compose/docker-compose.prod.yml`. Caddy config: `deploy/compose/Caddyfile`. Secrets template: `.env.example`. Image build script: `deploy/build-images.sh`. Variable reference: `docs/ENVIRONMENT.md`.
- The stack idles at about 1.15 GiB of RAM. The image BUILD needs more (see swap, step 4).
- It is a demo: the bank is a mock, nothing moves real money. The chaos tool is deliberately not deployed.

## Why not Render, Vercel, Netlify, Railway, Fly

Zerodrift is 7 always-on backend services plus Postgres, Kafka and Redis. Vercel and Netlify run static sites and short serverless functions: they cannot run Kafka, Postgres or long-lived workers. Render's free tier has no Kafka, sleeps idle services (which breaks the background recovery and webhook workers), and its free Postgres expires. There is no permanent free Kafka anywhere. So: **one VM that runs everything** (about 1.15 GiB), which is also the simplest thing.

## Step 1: Get a free VM (pick one)

**A. Azure for Students (recommended, no credit card):**
1. Go to https://azure.microsoft.com/free/students and sign in with your college email. You get $100 credit, valid one year (you must be 18 or older and verify your student status).
2. Portal, Virtual machines, Create:
   - Image: **Ubuntu Server 24.04 LTS**
   - Size: at least **2 vCPU and 4 GB RAM** (for example `Standard_B2s`; check the price in the portal, it uses your credit)
   - Authentication: SSH public key (download the `.pem` it creates)
   - Disk: 30 GB is enough
   - Networking: allow inbound **22** (SSH), **80** and **443**; make the public IP **Static**
3. Note the VM's **public IP**.
4. To save credit when you are not showing it, **Stop (deallocate)** the VM in the portal. A static IP stays; a dynamic one may change.

**B. Oracle Cloud Always Free (Ampere A1):** allowance was cut to 2 OCPU / 12 GB in June 2026, and "Out of host capacity" errors are common. Same steps as above if you get one.

## Step 2: Get 3 hostnames pointing at the VM

You need three names that all point to the VM's public IP (DNS A records):
- `console.<yourdomain>` (landing page and operator console)
- `shop.<yourdomain>` (demo shop)
- `api.<yourdomain>` (merchant API)

No domain? Use a free dynamic-DNS service such as DuckDNS: create three subdomains and set each to the VM's IP. Wait a few minutes, then check from your laptop: `nslookup console.yourname.duckdns.org` must show the VM's IP.

## Step 3: Connect and install Docker

```bash
ssh -i <your-key>.pem azureuser@<VM_PUBLIC_IP>

sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
exit
```
Log in again (so the `docker` group applies) and check `docker run --rm hello-world`.

## Step 4: Add swap (the image build uses more memory than the running stack)

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

## Step 5: Get the code and create the secrets file

```bash
git clone https://github.com/namanpardasani/zerodrift.git
cd zerodrift

CONSOLE_HOST=console.yourname.duckdns.org   # CHANGE the three hostnames to yours
SHOP_HOST=shop.yourname.duckdns.org
API_HOST=api.yourname.duckdns.org

cat > .env <<EOF
REGISTRY=
TAG=latest
CONSOLE_HOST=$CONSOLE_HOST
SHOP_HOST=$SHOP_HOST
API_HOST=$API_HOST
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=\n')
ADMIN_TOKEN=$(openssl rand -hex 24)
GATEWAY_CALLBACK_SECRET=$(openssl rand -hex 24)
WEBHOOK_ENCRYPTION_KEY=$(openssl rand -base64 32)
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
DASHBOARD_PASSWORD=CHOOSE-A-LONG-PASSWORD-HERE
EOF
chmod 600 .env
```
Then edit `DASHBOARD_PASSWORD` with `nano .env` (this is the console login; user is `admin`). Use letters, digits and `-` `_` only: no spaces and no `$`, because the seed script reads this file with the shell. Never commit `.env`; it is already git-ignored.

## Step 6: Build the images (slow the first time: 10 to 30 minutes)

```bash
deploy/build-images.sh
docker images | grep zerodrift-
```
It builds 7 images (ledger, payments, webhook, reconciliation, mock-gateway, dashboard-api, demo-shop). If a build fails because of the network, run it again (it retries and reuses cached layers).

## Step 7: Start everything

```bash
docker compose -f deploy/compose/docker-compose.prod.yml --env-file .env up -d
docker compose -f deploy/compose/docker-compose.prod.yml --env-file .env ps
```
Wait 1 to 2 minutes until every service shows `healthy`. Caddy requests the HTTPS certificates automatically on the first visit (ports 80 and 443 must be open and DNS must already point at the VM).

## Step 8: Verify the public surface

```bash
docker run --rm \
  -e CONSOLE_URL=https://$CONSOLE_HOST -e SHOP_URL=https://$SHOP_HOST -e API_URL=https://$API_HOST \
  -v "$PWD/scripts/verify-prod-stack.mjs:/v.mjs:ro" zerodrift-dashboard-api node /v.mjs
```
It must end with **"The public surface is as intended"**. It proves the console needs a login, operator routes (`/admin`, `/internal`, `/metrics`) are not reachable from the internet, and the merchant API demands a key.

## Step 9: Seed demo data

```bash
WEBHOOK_TARGET=https://$SHOP_HOST/webhooks scripts/seed-demo.sh
```
It creates merchants, customers and about 80 payments (with duplicates, refunds, and one payment whose bank answer is lost and then recovered), checks the books and prints each merchant's API key once. Copy those keys somewhere safe.

## Step 10: Use it

- `https://<CONSOLE_HOST>`: landing page (the top-bar pill should say "books balanced · drift ₹0.00")
- `https://<CONSOLE_HOST>/app`: console, login `admin` and your `DASHBOARD_PASSWORD`
- `https://<SHOP_HOST>`: demo shop (click +₹1,000.00, add an item, Pay from wallet; the order should become Paid with a receipt)
- The chaos bench is intentionally absent in production.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser says certificate error or can't connect | DNS not pointing at the VM yet, or port 80/443 closed in the cloud firewall. `docker compose ... logs caddy` shows the certificate attempts |
| `up` stops with "set POSTGRES_PASSWORD in .env" | A secret is missing in `.env`; the message names it |
| Shop order stays "Confirming payment" | The webhook to the shop cannot reach its own public URL. Check `docker compose ... logs webhook`. The shop host must be a PUBLIC https name (private addresses are blocked on purpose) |
| A service restarts in a loop | `docker compose ... logs --tail=50 <service>`; production refuses development secrets and names the variable |
| Step 8 fails only for the checks that call your own public address from inside the VM | Some clouds do not loop traffic back to the VM's own public IP. Run the same check from your laptop instead: `CONSOLE_URL=https://... SHOP_URL=https://... API_URL=https://... node scripts/verify-prod-stack.mjs` (Node 20+) |
| Build is killed ("Killed") | Out of memory: make sure swap is on (step 4) or use a 4 GB VM |
| Disk full | `docker system prune -f` (removes unused build cache and images) |

## Day-2

- **Update:** `cd zerodrift && git pull && deploy/build-images.sh && docker compose -f deploy/compose/docker-compose.prod.yml --env-file .env up -d`
- **Back up the database:** `docker compose -f deploy/compose/docker-compose.prod.yml --env-file .env exec -T postgres pg_dump -U zerodrift ledger > ledger.sql` (repeat for `payments`, `webhook`, `reconciliation`, `gateway`)
- **Stop paying:** stop (deallocate) the VM in the portal, or delete the resource group.

## Before you share the link

- [ ] `.env` is not committed anywhere and has a long dashboard password
- [ ] Step 8 passes
- [ ] only ports 22, 80 and 443 are open in the cloud firewall (restrict 22 to your own IP if you can)
- [ ] you know it is a portfolio demo: it does not move real money
