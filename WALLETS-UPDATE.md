# Wallet settings update

Super admin: Admins → payout link → Edit. Enter one HTTPS URL per line; the first is the default. Up to 20 links are supported.
Managers: open a partner and select a payout link, or use the default. Only links belonging to the assigned manager are accepted. Removed links and partner reassignments fall back to the current manager default.

My wallets shows unavailable bank card, bank transfer and USDT transfer cards, plus a crypto wallet setup link. The green card opens the configured external service; it does not implement wallet authorization, provider integrations or execute payments. Existing payout requests remain unchanged.

The database column is added automatically on startup. Existing manager links are retained. Server and embedded browser JavaScript passed syntax checks. External services and production payments were not tested.
