// In-memory KV + Request mocks for unit testing the worker.
export function mockEnv(seed = {}, apiKey = 'ADMINKEY') {
  const store = new Map(Object.entries(seed));
  return {
    API_KEY: apiKey,
    ADMIN_EMAIL: 'admin@test',
    ADMIN_PASS: 'adminpass',
    _store: store,
    DB: {
      get:    async (k) => (store.has(k) ? store.get(k) : null),
      put:    async (k, v) => { store.set(k, v); },
      delete: async (k) => { store.delete(k); },
    },
  };
}

export function makeReq(body) {
  return new Request('http://test.local/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
