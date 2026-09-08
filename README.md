# AstraTrader Worker

Headless finalized Solana transaction discovery for EnRICHedCreations/AstraTrader. It posts signature batches to the web app's authenticated ingestion queue. By default it holds no wallet key and cannot sign or place trades. An optional isolated signer is described below.

Deploy Hatch: Node 24, service type worker, install `npm ci --ignore-scripts`, build `npm test`, start `npm start`.

Set `ASTRATRADER_URL` to the main app's actual HTTPS deployment URL. Set `INGEST_TOKEN` to the same random token used by the app. Set `SOLANA_RPC_URL` to the dedicated read-only mainnet endpoint. Set `WORKER_STATE_PATH` to a file on a confirmed durable volume, and set `PERSISTENCE_CONFIRMED=true` only after checking that volume survives redeployments. `DISCOVERY_PROGRAMS` defaults to Jupiter v6; scope this to provider capacity.

Set `DISABLE_DISCOVERY=true` on the main app to avoid duplicate polling. The web app still verifies, processes and records incoming signatures. Webhooks and polling may deliver duplicate signatures; its durable queue deduplicates them.

Cold start samples the newest 100 signatures. Subsequent polling uses bounded pagination and durable checkpoints. This is not a promise of full-chain coverage. A failed publication does not advance the checkpoint. Monitor the main app's ingestion lag and queue backlog.

The worker cannot start until its environment and persistent storage are configured. No production secrets are included.

## Optional isolated live signer

The worker can also run the isolated signer when `SIGNER_ENABLE_LIVE=true`. It pulls intents from the web app over authenticated outbound HTTPS and reports only public status and finalized accounting; it exposes no signing port. Set `SIGNER_TRANSPORT=pull` on the web app and use the same `SIGNER_TOKEN` on both. Keep the keypair only in the worker (`SIGNER_KEYPAIR_BASE64` or a protected `SIGNER_KEYPAIR_FILE`), never in the web project. `SIGNER_DATABASE_PATH` must be a separate durable database file. All risk policy, reviewed asset and paper-evidence gates still apply. `LIVE_APPROVAL_BASE64` can carry the exact reviewed artifact when file mounts are unavailable.

The shared signing implementation is vendored from the main AstraTrader runtime under `runtime/`; changes to its signing policy must be synchronized and tested in both repositories. This revision does not claim successful live-money execution.

Complete setup, environment, wallet and operations guide: [AstraTrader user guide](https://github.com/EnRICHedCreations/AstraTrader/blob/main/docs/USER_GUIDE.md).
