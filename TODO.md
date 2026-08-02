# TODO - #219 Integration tests for deposit/withdraw flows

- [x] Inspect remaining code paths for deposit/withdraw + event cursor/DLQ handling

- [x] Implement integration test: happy-path deposit + withdraw with DB assertions

- [x] Implement integration test: error-path deposit/withdraw where event processing fails → DLQ row created

- [ ] Add/adjust Jest mocks for Stellar RPC and event listener handling so tests are deterministic
- [ ] Ensure test DB seeding creates: User, CustodialWallet (or wallet fixture), Session, EventCursor
- [ ] Update CI workflow (.github/workflows/node-ci.yml) env vars needed at module-load time for tests
- [ ] Run tests locally (jest) and ensure lint/typecheck passes
- [ ] Update TODO checklist to completed when green

