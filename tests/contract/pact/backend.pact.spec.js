const { Pact } = require('@pact-foundation/pact');
const { like, eachLike } = require('@pact-foundation/pact').Matchers;
const { fetch } = require('node-fetch');

describe('Soroban contract API', () => {
  const provider = new Pact({
    consumer: 'Frontend',
    provider: 'Backend',
    port: 8080,
  });

  beforeAll(() => provider.setup());
  afterAll(() => provider.finalize());
  afterEach(() => provider.verify());

  describe('GET /api/transaction/:hash', () => {
    it('returns transaction status', async () => {
      await provider.addInteraction({
        state: 'transaction exists',
        uponReceiving: 'a request for transaction status',
        withRequest: {
          method: 'GET',
          path: '/api/transaction/0x123',
        },
        willRespondWith: {
          status: 200,
          body: {
            txHash: '0x123',
            status: 'success',
            blockNumber: 123456,
          },
        },
      });

      const response = await fetch('http://localhost:8080/api/transaction/0x123');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        txHash: '0x123',
        status: 'success',
        blockNumber: 123456,
      });
    });
  });
});
