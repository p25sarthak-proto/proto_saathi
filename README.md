# Proto mock server

This server mocks Delhivery and Pine Labs, plus two capabilities neither offers today. Endpoint paths and field names follow the partners' public docs. Before recording, check them against the Delhivery developer portal you have access to.

## Deploy (about 5 minutes)
1. Push this folder to a GitHub repo.
2. Go to vercel.com, choose New Project, and import the repo. You don't need to change any settings.
3. Set these environment variables (Project → Settings → Environment Variables), then redeploy:
   - `GNANI_API_KEY` (**required** for voice; from app.gnani.ai)
   - `TELEGRAM_BOT_TOKEN` (**required** for voice notes; from @BotFather)
   - `DELHIVERY_TOKEN` (default `proto-delhivery-token`)
   - `PINE_CLIENT_ID` / `PINE_CLIENT_SECRET` (default `proto-client` / `proto-secret`)
   - `DELIVER_AFTER_SEC` (default 120, which is how long until tracking shows "Delivered")
4. Open `https://<your-app>.vercel.app/`. It should list every endpoint.

For the live dashboard to keep its log across serverless invocations, add Upstash Redis from the Vercel Marketplace (Storage tab, free tier) and connect it to the project. It sets `KV_REST_API_URL` / `KV_REST_API_TOKEN` automatically. Without it the log only lives in memory and calls will go missing from the dashboard.

Live dashboard: `https://<your-app>.vercel.app/dashboard`

To run locally instead: `npm install && npm start` (port 3000).

## Register as custom connectors on AgenticOrg
- **Delhivery (mock)**
  - Base URL: `https://<your-app>.vercel.app`
  - Header: `Authorization: Token proto-delhivery-token`
- **Pine Labs (mock)**
  - Same base URL.
  - First call `POST /api/auth/v1/token`, then send `Authorization: Bearer <access_token>` on every other call.
  - If AgenticOrg has a working native Pine Labs connector, use it for orders and keep only the envelope endpoints here.

| Partner | Endpoint | Purpose |
|---|---|---|
| Gnani (real, proxied) | `POST /gnani/stt` `{telegram_file_id, language_code}` | Forwards to `POST https://api.vachana.ai/stt/v3` as multipart and returns Gnani's reply unchanged |
| Gnani (real, proxied) | `POST /gnani/tts` `{text, language, voice, telegram_chat_id, caption}` | Calls `POST https://api.vachana.ai/api/v1/tts/inference` and sends the audio to Telegram |
| Delhivery | `GET /c/api/pin-codes/json/?filter_codes=PIN` | Pincode serviceability |
| Delhivery | `POST /api/cmu/create.json` (form `format=json&data={...}` or JSON) | Create shipment |
| Delhivery | `GET /api/v1/packages/json/?waybill=X` | Track shipment |
| Delhivery | `POST /api/p/edit` `{waybill, cancellation:"true"}` | Cancel shipment |
| Delhivery | `POST /fm/request/new/` | Pickup request |
| Pine Labs | `POST /api/auth/v1/token` | Get access token |
| Pine Labs | `POST /api/pay/v1/orders` (`pre_auth: true`, amount in paise) | Create order |
| Pine Labs | `PUT /api/pay/v1/orders/{id}/capture` | Capture after delivery |
| Pine Labs | `PUT /api/pay/v1/orders/{id}/cancel` | Release the hold |
| **Imagined:** Pine Labs | `GET /api/pay/v1/envelopes/{id}` and `POST /api/pay/v1/envelopes/{id}/authorize` | Delegated health-spend envelope |
| **Imagined:** Delhivery | `POST /api/hyperlocal/v1/basket-quote` | Priced protein basket from the nearest partner store |

## Triggering bad paths (change these values in the Members sheet before a run)
| Input | Result |
|---|---|
| Pincode `380015` (any normal pin) | Happy path |
| `000000` | Not serviceable |
| `380099` | No rider available |
| `380098` | Timeout (9 s hang, then 504) |
| `380097` | Malformed reply (HTTP 200, broken JSON) |
| `380096` | Delivery attempt fails, then RTO |
| Envelope `ENV-LOW` | Balance too low (₹50 available) |
| Envelope `ENV-SLOW` | Pine Labs timeout |
